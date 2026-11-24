// 可插拔模型客户端 + 模型路由。
// 默认 LocalDeterministicModel：离线、确定性、无语义幻觉，仅用于证明人格注入与
// 记忆召回链路组装正确；它明确标注“未配置外部模型端点”，绝不冒充真实大模型。
// 生产接入：设置 SOULVIKING_LLM_BASE_URL（OpenAI 兼容 /chat/completions）。
// 并发保护：OpenAICompatibleModel 的所有请求经过全局串行互斥队列，
//           同一时间只有一个请求打到模型端点（防本地 GPU 显存被并发打爆）。

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ModelRequest {
  model: string
  messages: ChatMessage[]
  maxTokens?: number
  temperature?: number
}

export interface ModelClient {
  chat(request: ModelRequest): Promise<string>
}

// ---- 全局串行互斥队列（promise chain 实现的 Mutex）----
// 所有 OpenAICompatibleModel 实例共享同一条队列：前一个请求 settle 之后，
// 下一个才发起；队列不因单个请求失败而中断。
let modelQueueTail: Promise<unknown> = Promise.resolve()

function enqueueSerial<T>(fn: () => Promise<T>): Promise<T> {
  const result = modelQueueTail.then(fn, fn)
  modelQueueTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export class LocalDeterministicModel implements ModelClient {
  async chat(request: ModelRequest): Promise<string> {
    const system = request.messages.find((m) => m.role === 'system')?.content ?? ''
    const user = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
    const personaLine = system
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('人格')) ?? ''
    const memCount = (system.match(/记忆\[viking:\/\//g) ?? []).length
    const head = `［本地确定性模型｜未配置外部模型端点｜model=${request.model}］`
    const memo = memCount > 0 ? `已注入 ${memCount} 条带 viking:// URI 的记忆。` : '未检索到相关记忆。'
    const body = personaLine ? `${personaLine}。` : ''
    return `${head}\n${body}${memo}\n针对你的消息「${user.slice(0, 160)}」，已完成人设注入与记忆上下文组装。`
  }
}

const DEFAULT_LLM_TIMEOUT_MS = 120_000

export class OpenAICompatibleModel implements ModelClient {
  private readonly baseUrl: string
  private readonly apiKey?: string
  private readonly timeoutMs: number

  constructor(baseUrl: string, apiKey?: string, timeoutMs?: number) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    this.apiKey = apiKey
    const fromEnv = Number(process.env.SOULVIKING_LLM_TIMEOUT_MS)
    this.timeoutMs =
      timeoutMs && timeoutMs > 0
        ? timeoutMs
        : Number.isFinite(fromEnv) && fromEnv > 0
          ? fromEnv
          : DEFAULT_LLM_TIMEOUT_MS
  }

  /** 对外入口：强制经过全局串行队列，同一时间只有一个请求在途。 */
  async chat(request: ModelRequest): Promise<string> {
    return enqueueSerial(() => this.chatNow(request))
  }

  private async chatNow(request: ModelRequest): Promise<string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      // 硬超时：本地模型 hang 住时不再永久阻塞整条链路。
      signal: AbortSignal.timeout(this.timeoutMs),
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxTokens ?? 1024,
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`model http ${res.status}: ${text.slice(0, 200)}`)
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    return data.choices?.[0]?.message?.content ?? ''
  }
}

/** 模型路由：按 Soul 的 model 字段选择客户端；未注册则回落默认客户端。 */
export class ModelRegistry {
  private readonly clients = new Map<string, ModelClient>()
  private readonly fallback: ModelClient

  constructor(fallback: ModelClient = new LocalDeterministicModel()) {
    this.fallback = fallback
  }

  register(model: string, client: ModelClient): void {
    this.clients.set(model, client)
  }

  get(model?: string): ModelClient {
    if (model && this.clients.has(model)) return this.clients.get(model) as ModelClient
    return this.fallback
  }

  isExternal(): boolean {
    return !(this.fallback instanceof LocalDeterministicModel)
  }
}

export function createModelRegistry(env: NodeJS.ProcessEnv = process.env): ModelRegistry {
  const base = env.SOULVIKING_LLM_BASE_URL
  if (base && base.trim()) {
    const client = new OpenAICompatibleModel(base.trim(), env.SOULVIKING_LLM_API_KEY)
    return new ModelRegistry(client)
  }
  return new ModelRegistry()
}
