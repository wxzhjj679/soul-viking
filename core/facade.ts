// SOUL-Viking 门面：极简「提示词注入器 + 外部工具派发员」+ 完整 DSH 灵魂引擎。
// 与宿主的分工铁律（Codex/Hermes 是总指挥，本中间件只是私人秘书）：
//  - L1(SoulService)：人格对话与提示词注入，不碰文件/命令；
//  - 灵魂引擎(dsh-soul/，danshuyue/dsh-agent-soul v0.10.6 原样移植)：
//    会忘事的记忆（清晰→模糊→只剩印象→遗忘，遗忘进档案不删除）、会变的人格、
//    会起伏的心情（心情值/七情/时间线，模型判定）、笔记、「心里惦记的事」、每日摘录日记。
//    每轮自动注入：数据边界(270)→人格(260)→记忆(250)→笔记(245)→目的(240)→心情(230)。
//    宿主绑定由 core/dsh/adapter.js 模拟（引擎 lib/** 零修改）；
//  - L2(VikingStore)：viking:// 跨会话记忆库（SQLite CRUD + 语义检索 + owner 隔离）；
//  - L3(SkillRouter + VerificationService)：意图路由 → 返回派发指引；验证取证 → 合并门禁。
// 团队组建（spawn_teammate / orchestrate）归宿主侧 DSH 插件（Sicaduj 版）管，本中间件不管理团队。

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDshSoul, type DshSoul, type DshToolDef } from './dsh/adapter.js'
import { createEmbedder, HashingEmbedder, type Embedder } from './embed.ts'
import { createModelRegistry, type ModelRegistry } from './llm.ts'
import { loadPersonas } from './loaders.ts'
import { SoulService } from './soul/router.ts'
import { createSkillRegistry, loadSkillRegistry, type SkillDispatch, type SkillMeta } from './skills/registry.ts'
import { SkillRouter, type RouteResult } from './skills/router.ts'
import type { RecallProvider } from './types.ts'
import { directoryRecursiveRecall } from './viking/recall.ts'
import { PersonaMemoryStore } from './viking/persona-memory.ts'
import { VikingStore } from './viking/store.ts'
import { VerificationService, type VerificationReport, type VerifyTask } from './verify/verifier.ts'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULT_PERSONA = {
  id: 'default',
  name: '默认人格',
  description: '通用对话人格',
  body: '你是一个乐于助人的助手，回答简洁、准确。',
  injectionDefault: 'prefer' as const,
}

export interface FacadeOptions {
  projectRoot?: string
  homeDir?: string
  dbPath?: string
  soulsDir?: string
  skillsRegistryPath?: string
  embedDim?: number
  defaultPersonaId?: string
  /** 关掉 DSH 灵魂引擎（测试或排障用）。 */
  disableDshSoul?: boolean
}

export interface HandleResult {
  intent: 'dialogue' | 'execute' | 'clarify'
  persona_id: string
  reply?: string
  memory_used?: string[]
  mode?: RouteResult['mode']
  skill?: string
  score?: number
  chain?: string[]
  question?: string
  candidates?: Array<{ name: string; description: string; score: number }>
  /** intent=execute 且单一技能命中时给出派发指引（链式任务请对每个技能调 skill_execute）。 */
  dispatch?: SkillDispatch
}

export class SoulViking {
  readonly viking: VikingStore
  readonly personaMemory: PersonaMemoryStore
  readonly soul: SoulService
  readonly skills: SkillRouter
  readonly verify: VerificationService
  readonly models: ModelRegistry
  readonly skillsRegistrySize: number
  private readonly homeDir: string
  private readonly dshDisabled: boolean
  private dshPromise: Promise<DshSoul | null> | null = null

  constructor(options: FacadeOptions = {}) {
    const projectRoot = options.projectRoot ?? PROJECT_ROOT
    const home = options.homeDir ?? process.env.SOULVIKING_HOME ?? join(projectRoot, 'data')
    this.homeDir = home
    this.dshDisabled = options.disableDshSoul === true
    const dbPath = options.dbPath ?? process.env.SOULVIKING_DB ?? join(home, 'viking.db')
    const soulsDir = options.soulsDir ?? process.env.SOULVIKING_SOULS_DIR ?? join(projectRoot, 'souls')
    const skillsPath =
      options.skillsRegistryPath ?? process.env.SOULVIKING_SKILLS ?? join(projectRoot, 'skills', 'registry.json')

    const embedder: Embedder = options.embedDim ? new HashingEmbedder(options.embedDim) : createEmbedder()
    this.viking = new VikingStore({ dbPath, embedder })
    this.personaMemory = new PersonaMemoryStore(this.viking.db, embedder)
    this.models = createModelRegistry()

    let personas = loadPersonas(soulsDir)
    if (personas.length === 0) personas = [DEFAULT_PERSONA]

    const defaultPersonaId =
      options.defaultPersonaId ??
      process.env.SOULVIKING_DEFAULT_PERSONA ??
      personas.find((p) => p.id === 'software-engineer')?.id ??
      personas[0].id

    const recallPort: RecallProvider = {
      recall: async (query, recallOptions) => {
        const result = await directoryRecursiveRecall(this.viking, query, recallOptions)
        return { chunks: result.chunks, topDirectory: result.topDirectory, traceId: result.trace.id }
      },
    }

    this.soul = new SoulService({
      personas,
      defaultPersonaId,
      memory: this.personaMemory,
      recall: recallPort,
      models: this.models,
      defaultModel: process.env.SOULVIKING_DEFAULT_MODEL,
      embedder,
    })

    const registry = loadSkillRegistry(skillsPath)
    this.skillsRegistrySize = registry.list().length
    this.skills = new SkillRouter(registry, { embedder })

    this.verify = new VerificationService()
  }

  // ---- DSH 灵魂引擎（danshuyue 版全量移植，惰性装配）----
  /**
   * 引擎实例（进程内单例，惰性初始化；失败返回 null 并降级——对话永远不因灵魂装配失败而中断）。
   * llmClient 走 core/llm.ts 的全局串行队列：心情判定/记忆提炼/日记与对话共用一条串行通道（显存保护）。
   * 未配 SOULVIKING_LLM_BASE_URL 时传 null，引擎按自己的降级路径走（心情不判、记忆原话直存）。
   */
  dshSoul(): Promise<DshSoul | null> {
    if (this.dshDisabled) return Promise.resolve(null)
    if (this.dshPromise === null) {
      const llmModel = process.env.SOULVIKING_LLM_MODEL ?? 'default'
      this.dshPromise = createDshSoul({
        homeDir: this.homeDir,
        cwd: process.env.SOULVIKING_DSH_CWD ?? process.cwd(),
        llmClient: this.models.isExternal() ? this.models.get(llmModel) : null,
        llmModel,
        log: (msg) => console.error(`[dsh-soul] ${msg}`),
      }).catch((error: unknown) => {
        console.error(`[dsh-soul] 引擎装配失败（已降级为无人格引擎模式）：${error instanceof Error ? error.message : error}`)
        return null
      })
    }
    return this.dshPromise
  }

  /** 引擎注册的四个工具（soul_memory / soul_goal / soul_note / soul_diary），原样透出给 MCP。 */
  async dshTools(): Promise<DshToolDef[]> {
    const dsh = await this.dshSoul()
    return dsh ? dsh.tools : []
  }

  /** 引擎工具的执行上下文（最近一轮会话的 header；tools/call 串行队列下无歧义）。 */
  async dshContext(): Promise<unknown> {
    const dsh = await this.dshSoul()
    return dsh ? dsh.currentContext() : {}
  }

  /** 观测面：心情/记忆卡/配置/最近摘录，全部读引擎自己的导出函数（不另造口径）。 */
  async dshStatus(): Promise<Record<string, unknown>> {
    const dsh = await this.dshSoul()
    if (dsh === null) return { ready: false, reason: '灵魂引擎未启用或装配失败（详见 stderr 日志）' }
    const out: Record<string, unknown> = { ready: true, dsh_home: dsh.dshHome }
    try { out.mood = dsh.moodState() } catch (error) { out.mood = { error: String(error) } }
    try { out.memory = dsh.memoryStats() } catch (error) { out.memory = { error: String(error) } }
    try {
      out.cards = { global: dsh.globalCard().records.length, project: dsh.projectCard().records.length }
    } catch (error) {
      out.cards = { error: String(error) }
    }
    try {
      const cfg = dsh.loadConfig() as Record<string, unknown>
      out.config = {
        ownerName: cfg.ownerName ?? '',
        enabled: cfg.enabled,
        memoryEnabled: cfg.memoryEnabled,
        moodEnabled: cfg.moodEnabled,
        notesEnabled: cfg.notesEnabled,
        purposeEnabled: cfg.purposeEnabled,
        diaryEnabled: cfg.diaryEnabled,
        selfEnabled: cfg.selfEnabled,
        memoryRecall: cfg.memoryRecall,
      }
    } catch (error) {
      out.config = { error: String(error) }
    }
    try { out.diary_recent = dsh.readRecentExcerpts(3) } catch (error) { out.diary_recent = { error: String(error) } }
    out.segments = dsh.segmentNames()
    out.tools = dsh.tools.map((t) => t.name)
    return out
  }

  // ---- L1 · Soul（人格对话 + DSH 灵魂引擎每轮注入）----
  /**
   * soul_chat：一次完整的「有灵魂」对话——
   *  1. beginTurn：落用户事件 → 引擎装配六段注入（数据边界/人格/衰减记忆/笔记/目的/心情钩子），
   *     段内部自动跑增量提取（这轮说的话该记的记进记忆卡）、日记素材收集、心情观察器挂载；
   *  2. 引擎的语气投递（心情低/高时挂在用户消息后的一句）随本轮请求一起下发；
   *  3. endTurn：落 assistant 事件 → 引擎在自己的串行链上异步判定这轮心情变化（心情值慢动只吃 1/3、
   *     七情即时动、时间线存档）；
   *  4. 记忆衰减/压缩/遗忘归档由引擎的 maintain 按自己的节奏跑（≥10 分钟一次），遗忘不是删除。
   */
  async soulChat(message: string, sessionId?: string, injectionMode?: string, owner?: string) {
    const sid = sessionId ?? 'default'
    const dsh = await this.dshSoul()
    const turn = dsh ? await dsh.beginTurn(sid, message) : null
    const chat = await this.soul.chat(
      message,
      sessionId,
      injectionMode,
      owner,
      turn
        ? {
            ...(turn.systemText !== '' ? { dshSegments: turn.systemText } : {}),
            ...(turn.toneMessages.length > 0 ? { toneMessages: turn.toneMessages } : {}),
          }
        : undefined,
    )
    if (dsh) await dsh.endTurn(sid, chat.reply)
    return {
      ...chat,
      ...(turn ? { soul_segments: turn.segments.map((s) => s.name) } : {}),
      ...(dsh ? { soul_mood: this.safeMood(dsh) } : {}),
    }
  }

  private safeMood(dsh: DshSoul): unknown {
    try {
      return dsh.moodState()
    } catch {
      return null
    }
  }

  switchPersona(personaId: string, sessionId?: string) {
    return this.soul.switchPersona(personaId, sessionId)
  }

  listPersonas() {
    return this.soul.listPersonas().map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      model: p.model ?? null,
      injectionDefault: p.injectionDefault,
    }))
  }

  async soulRecall(personaId: string, query: string) {
    return this.soul.recall(personaId, query)
  }

  async soulRemember(personaId: string, category: string, content: string) {
    return this.soul.remember(personaId, category, content)
  }

  // ---- L2 · Viking（viking:// 跨会话记忆库：SQLite CRUD + 语义检索）----
  async memoryStore(text: string, uri?: string, tags?: string[], owner?: string) {
    return this.viking.storeMemory(text, uri, tags ?? [], owner ?? '')
  }

  async memoryRecall(query: string, topK = 10, owner?: string) {
    const result = await directoryRecursiveRecall(
      this.viking,
      query,
      owner === undefined ? { topK } : { topK, owner },
    )
    return {
      topDirectory: result.topDirectory,
      injectedL1: result.injectedL1,
      injectedL0: result.injectedL0,
      traceId: result.trace.id,
      chunks: result.chunks,
    }
  }

  async memoryForget(uriOrQuery: string, owner?: string) {
    return this.viking.forget(uriOrQuery, owner)
  }

  listTraces(limit?: number) {
    return this.viking.listTraces(limit)
  }

  // ---- L3 · Skill 路由 + 验证（派发员：只指路，不干活）----
  listSkills(): SkillMeta[] {
    return this.skills.listSkills()
  }

  skillRoute(message: string): Promise<RouteResult> {
    return this.skills.route(message)
  }

  skillExecute(skillName: string, input: Record<string, unknown> = {}) {
    const skill = this.skills.listSkills().find((s) => s.name === skillName)
    if (!skill) throw new Error(`skill_execute: 未注册技能 ${skillName}`)
    // 调度员定位：不自建执行器，返回派发指引（外部 MCP / 命令提示 / 宿主自办），
    // 由宿主 Agent（Codex/Hermes）调用成熟生态去干活，干完回来取证。
    const dispatch = skill.dispatch ?? {
      kind: 'agent' as const,
      instructions: '未登记派发方式：请宿主 Agent 用自身工具完成该任务；完成后回到本中间件 verify_run 取证。',
    }
    return {
      skill: skill.name,
      status: 'dispatched' as const,
      requires_verification: skill.requires_verification,
      input,
      dispatch,
      note: skill.requires_verification
        ? '该技能要求验证：宿主按 dispatch 指引执行后，请调用 verify_register_task + verify_run 获取可审计证据，证据非空且通过才可 auto_merge。'
        : '已返回派发指引；宿主 Agent 按 dispatch 指引调用外部能力执行，本中间件负责路由与验证门禁。',
    }
  }

  registerVerifyTask(task: VerifyTask) {
    this.verify.registerTask(task)
    return { registered: true, taskId: task.taskId }
  }

  verifyRun(taskId: string, task?: VerifyTask): Promise<VerificationReport> {
    return this.verify.run(taskId, task)
  }

  verifyEvidence(taskId: string) {
    return this.verify.evidence(taskId)
  }

  // ---- 二合一入口：自然语言 -> 意图 -> 对话或派发指引 ----
  async handle(message: string, sessionId?: string, owner?: string): Promise<HandleResult> {
    const route = await this.skills.route(message)
    const personaId = this.soul.resolvePersonaId(sessionId)

    if (route.mode === 'dialogue') {
      // 统一走 soulChat：对话同样经过灵魂引擎的每轮注入与记账（二合一入口不豁免）。
      const chat = await this.soulChat(message, sessionId, undefined, owner)
      return {
        intent: 'dialogue',
        persona_id: chat.persona_id,
        reply: chat.reply,
        memory_used: chat.memory_used,
        mode: 'dialogue',
      }
    }
    if (route.mode === 'explicit' || route.mode === 'matched') {
      return {
        intent: 'execute',
        persona_id: personaId,
        mode: route.mode,
        skill: route.skill.name,
        ...(route.mode === 'matched' ? { score: route.score } : {}),
        candidates: route.candidates.slice(0, 3),
        ...(route.skill.dispatch ? { dispatch: route.skill.dispatch } : {}),
      }
    }
    if (route.mode === 'chain') {
      return {
        intent: 'execute',
        persona_id: personaId,
        mode: 'chain',
        chain: route.chain.map((s) => s.name),
        candidates: route.candidates.slice(0, 3),
      }
    }
    return {
      intent: 'clarify',
      persona_id: personaId,
      mode: route.mode,
      question: route.question,
      candidates: route.candidates.slice(0, 3),
    }
  }

  close(): void {
    if (this.dshPromise !== null) {
      // 已装配才需要卸载（定时器都是 unref 的，这里只走引擎自己的 disposer）
      void this.dshPromise.then((dsh) => {
        try {
          dsh?.dispose()
        } catch { /* 卸载失败不阻断退出 */ }
      })
    }
    this.viking.close()
  }
}

export { createSkillRegistry }
