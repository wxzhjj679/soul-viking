// core/dsh/adapter.js 的类型声明（适配层是胶水代码，用 JS 写；引擎本体在 dsh-soul/lib/**）。

export interface DshToolDef {
  name: string
  description: string
  parameters: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
    additionalProperties?: boolean
  }
  output?: {
    schema?: Record<string, unknown>
    render?: (args: Record<string, unknown>, value: unknown) => Array<{ type: string; text: string }> | undefined
  }
  execute: (args: Record<string, unknown>, context?: unknown) => Promise<unknown> | unknown
}

export interface DshTurn {
  segments: Array<{ name: string; text: string }>
  systemText: string
  toneMessages: string[]
}

export interface DshSoul {
  dshHome: string
  beginTurn(sessionId: string, userText: string, opts?: { cwd?: string }): Promise<DshTurn>
  endTurn(sessionId: string, assistantText: string): Promise<void>
  currentContext(): { agent?: unknown; session: { header: { id: string; cwd: string } } }
  tools: DshToolDef[]
  segmentNames(): Array<{ name: string; order: number }>
  loadConfig(): Record<string, unknown>
  saveConfig(patch: Record<string, unknown>): unknown
  moodState(cwd?: string): Record<string, unknown>
  memoryStats(cwd?: string): Record<string, unknown>
  globalCard(): { records: unknown[] }
  projectCard(cwd?: string): { records: unknown[] }
  readRecentExcerpts(days?: number): unknown[]
  dispose(): void
}

export interface CreateDshSoulOptions {
  homeDir: string
  dshHome?: string
  cwd?: string
  /** 带串行队列的 ModelClient（chat(request) -> string）；null = 离线降级（引擎自己的无 llm 路径）。 */
  llmClient?: { chat(request: { model: string; messages: Array<{ role: string; content: string }>; maxTokens?: number; temperature?: number }): Promise<string> } | null
  llmModel?: string
  log?: (msg: string) => void
}

export function createDshSoul(options: CreateDshSoulOptions): Promise<DshSoul>
