// MCP 工具注册：把门面方法暴露为统一工具接口（人格注入 + 记忆 + 路由派发 + 验证 + DSH 灵魂引擎）。
// 工具入参使用 JSON Schema 描述（供 MCP client 生成 UI / 校验）。

import type { SoulViking } from '../core/facade.ts'
import type { DshToolDef } from '../core/dsh/adapter.js'
import { validateVerifyTask, type VerifyTask } from '../core/verify/verifier.ts'

export interface ToolDef {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`缺少必填字符串参数：${key}`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' ? value : undefined
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value)
  return undefined
}

function stringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key]
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

function recordArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key]
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * DSH 灵魂引擎注册的工具（soul_memory / soul_goal / soul_note / soul_diary）原样透传：
 * name/description/parameters 逐字保留（引擎自己按 DSH Q39/Q07 的硬规则写的 schema），
 * execute 的 context 传「最近一轮会话」——tools/call 在协议层串行，无并发歧义；
 * output.render 存在时按引擎自己的渲染口径出文本。
 */
function convertDshTool(facade: SoulViking, def: DshToolDef): ToolDef {
  return {
    name: def.name,
    description: def.description,
    inputSchema: {
      type: 'object',
      properties: (def.parameters?.properties ?? {}) as Record<string, unknown>,
      ...(Array.isArray(def.parameters?.required) ? { required: def.parameters.required } : {}),
      additionalProperties: def.parameters?.additionalProperties ?? false,
    },
    handler: async (args) => {
      const context = await facade.dshContext()
      const value = await def.execute(args, context)
      const rendered = def.output?.render?.(args, value)
      if (Array.isArray(rendered) && rendered.length > 0) {
        return rendered.map((r) => r.text).join('\n')
      }
      return value
    },
  }
}

export function buildTools(facade: SoulViking, dshTools: DshToolDef[] = []): ToolDef[] {
  const tools: ToolDef[] = [
    // ---------------- L1 · Soul ----------------
    {
      name: 'soul_chat',
      description: 'L1 Soul 对话：按会话绑定的人设注入人格与相关记忆后生成回复。',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: '用户消息' },
          session_id: { type: 'string', description: '会话 ID；绑定该会话的人设' },
          injection_mode: { type: 'string', enum: ['prefer', 'replace', 'append'], description: '提示词注入模式' },
          owner: { type: 'string', description: '记忆所有者 ID（多用户部署必传；只召回该 owner 私有 + 全局记忆）' },
        },
        required: ['message'],
        additionalProperties: true,
      },
      handler: (args) =>
        facade.soulChat(
          requireString(args, 'message'),
          optionalString(args, 'session_id'),
          optionalString(args, 'injection_mode'),
          optionalString(args, 'owner'),
        ),
    },
    {
      name: 'soul_switch_persona',
      description: 'L1 切换人设：传 session_id 则仅覆盖该会话；不传则修改全局默认人设。',
      inputSchema: {
        type: 'object',
        properties: {
          persona_id: { type: 'string', description: '目标人设 ID' },
          session_id: { type: 'string', description: '会话 ID（可选）' },
        },
        required: ['persona_id'],
        additionalProperties: true,
      },
      handler: (args) => facade.switchPersona(requireString(args, 'persona_id'), optionalString(args, 'session_id')),
    },
    {
      name: 'soul_list_personas',
      description: 'L1 列出可用人设。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      handler: () => facade.listPersonas(),
    },
    {
      name: 'soul_recall',
      description: 'L1 检索某人设的私有记忆（结果带可追溯 viking:// URI）。',
      inputSchema: {
        type: 'object',
        properties: {
          persona_id: { type: 'string' },
          query: { type: 'string' },
          top_k: { type: 'number' },
        },
        required: ['persona_id', 'query'],
        additionalProperties: true,
      },
      handler: (args) => facade.soulRecall(requireString(args, 'persona_id'), requireString(args, 'query')),
    },
    {
      name: 'soul_remember',
      description: 'L1 写入某人设的私有记忆。',
      inputSchema: {
        type: 'object',
        properties: {
          persona_id: { type: 'string' },
          category: { type: 'string', description: '记忆分类，如 preference/project/identity' },
          content: { type: 'string' },
        },
        required: ['persona_id', 'category', 'content'],
        additionalProperties: true,
      },
      handler: (args) =>
        facade.soulRemember(
          requireString(args, 'persona_id'),
          requireString(args, 'category'),
          requireString(args, 'content'),
        ),
    },

    // ---------------- L2 · Viking Memory ----------------
    {
      name: 'memory_store',
      description: 'L2 写入 viking:// 记忆，自动生成 L0/L1/L2 三层表示；同目录高相似条目会被标记冲突。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '完整内容（L2）' },
          uri: { type: 'string', description: '可选 viking:// URI，如 viking://memories/user/preferences' },
          tags: { type: 'array', items: { type: 'string' } },
          owner: { type: 'string', description: '记忆所有者 ID；缺省为全局记忆（所有 owner 可见）' },
        },
        required: ['text'],
        additionalProperties: true,
      },
      handler: (args) =>
        facade.memoryStore(
          requireString(args, 'text'),
          optionalString(args, 'uri'),
          stringArray(args, 'tags'),
          optionalString(args, 'owner'),
        ),
    },
    {
      name: 'memory_recall',
      description: 'L2 目录递归检索：定位最高分目录后下钻，Top-3 注入 L1 概览、其余注入 L0 摘要；返回检索轨迹 ID。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          top_k: { type: 'number' },
          owner: { type: 'string', description: '记忆所有者 ID；传入后只返回该 owner 私有 + 全局记忆' },
        },
        required: ['query'],
        additionalProperties: true,
      },
      handler: (args) =>
        facade.memoryRecall(
          requireString(args, 'query'),
          optionalNumber(args, 'top_k') ?? 10,
          optionalString(args, 'owner'),
        ),
    },
    {
      name: 'memory_forget',
      description: 'L2 遗忘：传 viking:// URI 直接标记；传查询则匹配相似条目标记为遗忘（不物理删除）。',
      inputSchema: {
        type: 'object',
        properties: {
          uri_or_query: { type: 'string' },
          owner: { type: 'string', description: '记忆所有者 ID；传入后只能遗忘该 owner 自己的记忆' },
        },
        required: ['uri_or_query'],
        additionalProperties: true,
      },
      handler: (args) => facade.memoryForget(requireString(args, 'uri_or_query'), optionalString(args, 'owner')),
    },
    {
      name: 'memory_traces',
      description: 'L2 查看最近的检索轨迹（directory-browsing trajectory）。',
      inputSchema: {
        type: 'object',
        properties: { limit: { type: 'number' } },
        additionalProperties: true,
      },
      handler: (args) => facade.listTraces(optionalNumber(args, 'limit') ?? 20),
    },

    // ---------------- L3 · Skill Router + Verification ----------------
    {
      name: 'skill_list',
      description: 'L3 列出已注册技能。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      handler: () => facade.listSkills(),
    },
    {
      name: 'skill_route',
      description: 'L3 意图路由：显式名称优先 > 有序多技能链 > 语义匹配（含阈值/歧义门禁）。',
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
        additionalProperties: true,
      },
      handler: (args) => facade.skillRoute(requireString(args, 'message')),
    },
    {
      name: 'skill_execute',
      description:
        'L3 技能派发：返回派发指引 dispatch（external_mcp=调宿主侧外部 MCP 如 ChatCut / command=本地命令提示 / agent=宿主自办）；宿主 Agent 按指引执行，要求验证的技能需随后调用 verify_register_task + verify_run 取证。',
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string' },
          input: { type: 'object', additionalProperties: true },
        },
        required: ['skill'],
        additionalProperties: true,
      },
      handler: (args) => facade.skillExecute(requireString(args, 'skill'), recordArg(args, 'input')),
    },
    {
      name: 'verify_register_task',
      description:
        'L3 注册一个验证任务（在目标目录执行命令；验证 Agent 只读源码、只采集证据）。安全策略：command 必须在白名单内（SOULVIKING_VERIFY_COMMANDS），target_dir 必须位于允许的根目录内（SOULVIKING_VERIFY_ROOTS），否则拒绝注册。',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          target_dir: { type: 'string', description: '必须位于允许的根目录内' },
          command: { type: 'string', description: '单个可执行名（不含路径），必须在白名单内，如 npm/pytest/tsc' },
          args: { type: 'array', items: { type: 'string' } },
          timeout_ms: { type: 'number' },
        },
        required: ['task_id', 'target_dir', 'command'],
        additionalProperties: true,
      },
      handler: (args) => {
        const task: VerifyTask = {
          taskId: requireString(args, 'task_id'),
          targetDir: requireString(args, 'target_dir'),
          command: requireString(args, 'command'),
          args: stringArray(args, 'args'),
        }
        const timeout = optionalNumber(args, 'timeout_ms')
        if (timeout !== undefined) task.timeoutMs = timeout
        // 注册入口即校验（服务层 registerTask/run 还会再校验一次，双保险）。
        validateVerifyTask(task)
        return facade.registerVerifyTask(task)
      },
    },
    {
      name: 'verify_run',
      description: 'L3 运行验证任务，返回 VerificationReport（passed + 可审计 evidence + failures）。',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
        additionalProperties: true,
      },
      handler: (args) => facade.verifyRun(requireString(args, 'task_id')),
    },
    {
      name: 'verify_evidence',
      description: 'L3 取回某任务的验证证据，供外部 Agent 审计。',
      inputSchema: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
        additionalProperties: true,
      },
      handler: (args) => facade.verifyEvidence(requireString(args, 'task_id')),
    },

    // ---------------- 二合一入口 ----------------
    {
      name: 'soul_viking_handle',
      description:
        '二合一入口：自然语言先经意图分类；对话走 L1 Soul，执行意图走 L4 技能路由并返回匹配/澄清结果。',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          session_id: { type: 'string' },
          owner: { type: 'string', description: '记忆所有者 ID（多用户部署必传）' },
        },
        required: ['message'],
        additionalProperties: true,
      },
      handler: (args) =>
        facade.handle(requireString(args, 'message'), optionalString(args, 'session_id'), optionalString(args, 'owner')),
    },

    // ---------------- DSH 灵魂引擎（danshuyue/dsh-agent-soul 原样移植）----------------
    // soul_memory / soul_goal / soul_note / soul_diary 由引擎自己注册，schema 与描述逐字透传。
    ...dshTools.map((def) => convertDshTool(facade, def)),
    {
      name: 'soul_status',
      description:
        'DSH 灵魂引擎观测面：当前心情（心情值/七情/时间线摘要）、记忆卡统计（全局/项目/清晰度分布）、配置开关、最近摘录日记、已装配注入段与工具清单。只读，全部取自引擎自己的导出函数。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      handler: () => facade.dshStatus(),
    },
  ]

  return tools
}
