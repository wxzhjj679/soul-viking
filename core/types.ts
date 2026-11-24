// 纯共享类型（无任何 IO 依赖）。Soul 层只依赖这里的接口/端口，
// 以便从结构上隔离文件系统与命令执行能力。

export type MemoryLayer = 'L0' | 'L1' | 'L2'

export interface MemoryChunk {
  uri: string
  layer: MemoryLayer
  text: string
  score: number
  directory: string
  neighborContext: string
}

export interface TraceStep {
  phase: string
  detail: Record<string, unknown>
}

export interface RetrievalTrace {
  id: string
  query: string
  steps: TraceStep[]
}

export type InjectionMode = 'prefer' | 'replace' | 'append'

export interface PersonaDef {
  id: string
  name: string
  description: string
  body: string
  model?: string
  injectionDefault: InjectionMode
}

export interface SystemPromptParts {
  baseInstructions?: string
  toolSchema?: string
  runtimeContext?: string
}

export interface PersonaMemoryItem {
  id?: string
  uri?: string
  personaId: string
  category: string
  content: string
  updatedAt: string
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 模型调用端口。具体客户端由外层注入（本地确定性 / OpenAI 兼容等）。 */
export interface ModelPort {
  chat(request: { model: string; messages: ChatTurn[]; maxTokens?: number; temperature?: number }): Promise<string>
}

export interface ModelProvider {
  get(model?: string): ModelPort
}

/** L2 记忆召回端口（Soul 层不感知底层是 SQLite 还是别的实现）。 */
export interface RecallProvider {
  recall(
    query: string,
    options?: { topK?: number; recordTrace?: boolean; owner?: string },
  ): Promise<{ chunks: MemoryChunk[]; topDirectory?: string | null; traceId?: string }>
}

/** 人设私有记忆端口（按人设隔离）。 */
export interface PersonaMemoryProvider {
  remember(personaId: string, category: string, content: string): Promise<PersonaMemoryItem>
  recall(personaId: string, query: string, topK?: number): Promise<PersonaMemoryItem[]>
  list(personaId: string): PersonaMemoryItem[]
}
