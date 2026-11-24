// L4 · Skill 意图路由（两阶段）：
//  阶段一 意图分类（规则引擎） -> dialogue / execute / route / specify_skill
//  阶段二 技能匹配：显式名称/别名（最高优先级）> 有序多技能链 > 语义 Top-K
//         阈值门禁（<0.65 澄清）+ 歧义门禁（Top1-Top2<0.1 让用户选）

import { cosine, createEmbedder, type Embedder } from '../embed.ts'
import type { SkillMeta, SkillRegistry } from './registry.ts'

export type IntentCategory = 'dialogue' | 'execute' | 'route' | 'specify_skill'

export interface IntentClassification {
  category: IntentCategory
  signals: string[]
}

const EXEC_VERBS = [
  '生成', '剪辑', '实现', '修改', '创建', '写', '运行', '测试', '部署', '分析', '总结',
  '翻译', '画', '做', '搭', '构建', '优化', '修复', '渲染', '导出', '转换',
  'generate', 'edit', 'implement', 'build', 'run', 'create', 'deploy', 'test', 'fix',
  'analyze', 'write', 'render', 'produce', 'convert', 'summarize', 'translate',
]

const DIALOGUE_MARKERS = /你好|您好|hi|hello|嗨|谢谢|感谢|哈哈|难过|开心|心情|在吗|早上好|晚安|怎么样/i

export function classifyIntent(message: string): IntentClassification {
  const lower = message.toLowerCase()
  const signals = EXEC_VERBS.filter((v) => lower.includes(v.toLowerCase()))
  const hasDialogue = DIALOGUE_MARKERS.test(message)
  if (signals.length > 0 && hasDialogue) return { category: 'route', signals }
  if (signals.length > 0) return { category: 'execute', signals }
  return { category: 'dialogue', signals }
}

export interface RouteCandidate {
  name: string
  description: string
  score: number
}

export type RouteResult =
  | { mode: 'explicit'; skill: SkillMeta; candidates: RouteCandidate[] }
  | { mode: 'dialogue'; candidates: RouteCandidate[] }
  | { mode: 'matched'; skill: SkillMeta; score: number; candidates: RouteCandidate[] }
  | { mode: 'ambiguous'; candidates: RouteCandidate[]; question: string }
  | { mode: 'clarify'; candidates: RouteCandidate[]; question: string }
  | { mode: 'chain'; chain: SkillMeta[]; candidates: RouteCandidate[] }

export interface SkillRouterOptions {
  embedder?: Embedder
  threshold?: number
  topK?: number
  ambiguityGap?: number
}

export class SkillRouter {
  private readonly registry: SkillRegistry
  private readonly embedder: Embedder
  private readonly threshold: number
  private readonly topK: number
  private readonly ambiguityGap: number
  /** 技能描述向量：首次 route 时一次批量嵌入并缓存（远程嵌入服务只打一发请求）。 */
  private skillEmbeddings: Array<{ skill: SkillMeta; vec: number[] }> | null = null
  private skillEmbeddingsPending: Promise<Array<{ skill: SkillMeta; vec: number[] }>> | null = null

  constructor(registry: SkillRegistry, options: SkillRouterOptions = {}) {
    this.registry = registry
    this.embedder = options.embedder ?? createEmbedder()
    this.threshold = options.threshold ?? 0.65
    this.topK = options.topK ?? 5
    this.ambiguityGap = options.ambiguityGap ?? 0.1
  }

  private ensureSkillEmbeddings(): Array<{ skill: SkillMeta; vec: number[] }> | Promise<Array<{ skill: SkillMeta; vec: number[] }>> {
    if (this.skillEmbeddings) return this.skillEmbeddings
    if (!this.skillEmbeddingsPending) {
      this.skillEmbeddingsPending = this.embedder
        .embedBatch(this.registry.list().map((skill) => `${skill.name} ${skill.aliases.join(' ')} ${skill.description}`))
        .then((vecs) => {
          this.skillEmbeddings = this.registry.list().map((skill, i) => ({ skill, vec: vecs[i] }))
          return this.skillEmbeddings
        })
        .catch((error) => {
          // 失败不缓存，下次 route 重试（嵌入服务临时不可用不应永久打瞎路由）。
          this.skillEmbeddingsPending = null
          throw error
        })
    }
    return this.skillEmbeddingsPending
  }

  listSkills(): SkillMeta[] {
    return this.registry.list()
  }

  /** 显式 Skill 指定：消息包含已注册 name 或 alias（不区分大小写）即锁定。 */
  matchExplicit(message: string): SkillMeta | null {
    const lower = message.toLowerCase()
    for (const skill of this.registry.list()) {
      for (const candidate of [skill.name, ...skill.aliases]) {
        const needle = candidate.toLowerCase()
        if (needle.length >= 2 && lower.includes(needle)) return skill
      }
    }
    return null
  }

  private scoreWithVec(queryVec: number[], skillEmbeddings: Array<{ skill: SkillMeta; vec: number[] }>): RouteCandidate[] {
    return skillEmbeddings
      .map(({ skill, vec }) => ({
        name: skill.name,
        description: skill.description,
        score: Number(cosine(queryVec, vec).toFixed(4)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.topK)
  }

  private async scoreAll(message: string): Promise<RouteCandidate[]> {
    const skillEmbeddings = await this.ensureSkillEmbeddings()
    const queryVec = await this.embedder.embed(message)
    return this.scoreWithVec(queryVec, skillEmbeddings)
  }

  private async bestSkill(part: string, skillEmbeddings: Array<{ skill: SkillMeta; vec: number[] }>): Promise<SkillMeta | null> {
    const explicit = this.matchExplicit(part)
    if (explicit) return explicit
    const queryVec = await this.embedder.embed(part)
    const top = this.scoreWithVec(queryVec, skillEmbeddings)[0]
    if (top && top.score >= this.threshold) return this.registry.get(top.name) ?? null
    return null
  }

  /** 有序多技能链：识别「先…再…/然后/之后/接着」等连接词拆分并按序匹配。 */
  async routeChain(message: string): Promise<SkillMeta[] | null> {
    const parts = message
      .split(/(?:先|再|然后|之后|接着|随后|;\s*|and then\b|then\b)/i)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length < 2) return null
    const skillEmbeddings = await this.ensureSkillEmbeddings()
    const picked: SkillMeta[] = []
    const seen = new Set<string>()
    for (const part of parts) {
      const skill = await this.bestSkill(part, skillEmbeddings)
      if (skill && !seen.has(skill.name)) {
        seen.add(skill.name)
        picked.push(skill)
      }
    }
    return picked.length >= 2 ? picked : null
  }

  async route(message: string): Promise<RouteResult> {
    const explicit = this.matchExplicit(message)
    if (explicit) return { mode: 'explicit', skill: explicit, candidates: await this.scoreAll(message) }

    const chain = await this.routeChain(message)
    if (chain) return { mode: 'chain', chain, candidates: await this.scoreAll(message) }

    const classification = classifyIntent(message)
    const candidates = await this.scoreAll(message)
    if (classification.category === 'dialogue') return { mode: 'dialogue', candidates }

    if (this.registry.list().length === 0) {
      return { mode: 'clarify', candidates: [], question: '当前没有已注册的技能，我可以先陪你聊聊需求。' }
    }

    const top = candidates[0]
    if (!top || top.score < this.threshold) {
      const names = candidates.slice(0, 3).map((c) => c.name).join('、') || '（无）'
      return {
        mode: 'clarify',
        candidates,
        question: `我不确定该用哪个技能，你是想让我做 ${names}，还是先聊聊具体需求？`,
      }
    }
    const second = candidates[1]
    if (second && top.score - second.score < this.ambiguityGap) {
      const options = candidates.slice(0, 3).map((c) => c.name)
      return {
        mode: 'ambiguous',
        candidates,
        question: `有几个技能都比较接近：${options.join('、')}，你选哪个？`,
      }
    }
    const skill = this.registry.get(top.name)
    if (!skill) return { mode: 'clarify', candidates, question: '技能注册表异常，暂时无法匹配。' }
    return { mode: 'matched', skill, score: top.score, candidates }
  }
}
