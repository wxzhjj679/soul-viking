// Skill 注册表：从 JSON 文件加载技能元数据。L4 层，允许文件读取。

import { readFileSync } from 'node:fs'

export interface SkillMeta {
  name: string
  aliases: string[]
  description: string
  input_schema: Record<string, unknown>
  output_schema: Record<string, unknown>
  requires_verification: boolean
  /** 派发指引：这个技能的活由谁干（外部 MCP / 命令 / 宿主 Agent 自己干）。 */
  dispatch?: SkillDispatch
}

/**
 * 调度员定位：本中间件不自建执行器，skill_execute 返回派发指引，
 * 由宿主 Agent（Codex/Hermes）调用成熟的外部能力去干活。
 * - external_mcp：宿主侧已注册的外部 MCP server（如 ChatCut 视频剪辑）；
 * - command：本地命令行工具（给出安装/调用提示，宿主 Agent 自己执行）；
 * - agent：宿主 Agent 用自身能力完成（如代码审查）。
 */
export interface SkillDispatch {
  kind: 'external_mcp' | 'command' | 'agent'
  /** external_mcp：宿主 Agent 配置里的 MCP server 名。 */
  server?: string
  /** external_mcp：建议优先使用的工具名（可空，由宿主自行发现）。 */
  tools?: string[]
  /** command：命令行提示（安装或调用示例）。 */
  command_hint?: string
  /** 给宿主 Agent 的派发说明：怎么干活、干完如何回来取证。 */
  instructions: string
}

const DISPATCH_KINDS = new Set(['external_mcp', 'command', 'agent'])

function normalizeDispatch(raw: unknown): SkillDispatch {
  const fallback: SkillDispatch = {
    kind: 'agent',
    instructions: '未登记派发方式：请宿主 Agent 用自身工具完成该任务；完成后回到本中间件 verify_run 取证。',
  }
  if (!raw || typeof raw !== 'object') return fallback
  const obj = raw as Record<string, unknown>
  const kind = typeof obj.kind === 'string' && DISPATCH_KINDS.has(obj.kind) ? obj.kind : 'agent'
  const dispatch: SkillDispatch = {
    kind: kind as SkillDispatch['kind'],
    instructions:
      typeof obj.instructions === 'string' && obj.instructions.trim() ? obj.instructions.trim() : fallback.instructions,
  }
  if (typeof obj.server === 'string' && obj.server.trim()) dispatch.server = obj.server.trim()
  if (Array.isArray(obj.tools)) {
    const tools = obj.tools.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    if (tools.length > 0) dispatch.tools = tools
  }
  if (typeof obj.command_hint === 'string' && obj.command_hint.trim()) dispatch.command_hint = obj.command_hint.trim()
  return dispatch
}

export interface SkillRegistry {
  skills: SkillMeta[]
  get(name: string): SkillMeta | undefined
  list(): SkillMeta[]
}

export function normalizeSkill(raw: unknown): SkillMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  if (!name) return null
  const aliases = Array.isArray(obj.aliases)
    ? obj.aliases.filter((a): a is string => typeof a === 'string')
    : typeof obj.alias === 'string'
      ? [obj.alias]
      : []
  const description = typeof obj.description === 'string' ? obj.description : ''
  const input_schema =
    obj.input_schema && typeof obj.input_schema === 'object'
      ? (obj.input_schema as Record<string, unknown>)
      : {}
  const output_schema =
    obj.output_schema && typeof obj.output_schema === 'object'
      ? (obj.output_schema as Record<string, unknown>)
      : {}
  return {
    name,
    aliases,
    description,
    input_schema,
    output_schema,
    requires_verification: obj.requires_verification === true,
    dispatch: normalizeDispatch(obj.dispatch),
  }
}

export function normalizeSkills(raw: unknown): SkillMeta[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { skills?: unknown }).skills)
      ? ((raw as { skills: unknown[] }).skills)
      : []
  const skills: SkillMeta[] = []
  for (const item of list) {
    const skill = normalizeSkill(item)
    if (skill) skills.push(skill)
  }
  return skills
}

export function createSkillRegistry(skills: SkillMeta[]): SkillRegistry {
  return {
    skills,
    get(name: string) {
      return skills.find((s) => s.name === name)
    },
    list() {
      return [...skills]
    },
  }
}

export function loadSkillRegistry(path: string): SkillRegistry {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return createSkillRegistry(normalizeSkills(parsed))
  } catch {
    return createSkillRegistry([])
  }
}
