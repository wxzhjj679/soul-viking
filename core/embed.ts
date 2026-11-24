// 向量化：与具体 Embedding 服务解耦。
// - 默认 HashingEmbedder：确定性哈希伪向量（词面/字符重合敏感），零依赖，离线与测试可用；
// - 设置 SOULVIKING_EMBED_URL 后自动切换 OpenAIEmbedder：走 OpenAI 兼容 /v1/embeddings
//   调用真实神经嵌入模型（本地 bge-m3 / nomic-embed-text 等），语义召回质量大幅提升。
//
// 接口统一为「异步 + 批量」（embed / embedBatch）：真实嵌入服务必然是网络 IO，
// 同步接口无法承载；批量接口让技能路由、记忆审核等场景能把 N 条文本合成一次请求。
//
// 安全/稳定性约束（与 core/llm.ts 同款）：
// - 全局串行互斥：同一时间只有一个嵌入 HTTP 请求在途（本地单卡防显存溢出）；
// - 请求带超时（SOULVIKING_EMBED_TIMEOUT_MS，默认 30s），失败显式抛错，
//   绝不静默降级回 hashing——混用两种向量空间会污染检索结果。

const CJK_CLASS = /[぀-ヿ㐀-䶿一-鿿가-힯]/

export interface Embedder {
  /** 向量维度。远程实现以服务端首次返回为准（未探测前为配置值或 0）。 */
  readonly dim: number
  /** 单条文本嵌入。 */
  embed(text: string): Promise<number[]>
  /** 批量嵌入（远程实现会分块合并 HTTP 请求）。 */
  embedBatch(texts: string[]): Promise<number[][]>
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** 分词：拉丁词/数字 + CJK 单字 + CJK 双字组（提升中文近邻召回的区分度）。 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens: string[] = []
  for (const m of lower.matchAll(/[a-z0-9]+/g)) tokens.push(m[0])
  const cjkChars: string[] = []
  for (const ch of lower) if (CJK_CLASS.test(ch)) cjkChars.push(ch)
  for (const ch of cjkChars) tokens.push(ch)
  for (let i = 0; i + 1 < cjkChars.length; i += 1) tokens.push(cjkChars[i] + cjkChars[i + 1])
  return tokens
}

export function l2normalize(v: number[]): number[] {
  let sum = 0
  for (const x of v) sum += x * x
  const norm = Math.sqrt(sum)
  if (norm === 0) return v
  return v.map((x) => x / norm)
}

export class HashingEmbedder implements Embedder {
  readonly dim: number

  constructor(dim = 256) {
    if (!Number.isFinite(dim) || dim < 8) throw new Error('embed dim must be >= 8')
    this.dim = Math.floor(dim)
  }

  /** 同步核心（确定性、无 IO），供 embed/embedBatch 包装。 */
  embedSync(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0)
    const tokens = tokenize(text)
    if (tokens.length === 0) return v
    for (const token of tokens) {
      const h = fnv1a(token)
      const idx = h % this.dim
      const sign = (h >>> 16) & 1 ? -1 : 1
      v[idx] += sign
    }
    return l2normalize(v)
  }

  async embed(text: string): Promise<number[]> {
    return this.embedSync(text)
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedSync(t))
  }
}

// ---- 全局串行互斥：同一时间只有一个嵌入请求打到模型服务（本地 GPU 保护）----
let embedQueueTail: Promise<unknown> = Promise.resolve()

function enqueueEmbedSerial<T>(fn: () => Promise<T>): Promise<T> {
  const result = embedQueueTail.then(fn, fn)
  embedQueueTail = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export interface OpenAIEmbedderOptions {
  /** OpenAI 兼容服务 base URL（含 /v1，如 http://127.0.0.1:11434/v1）。 */
  baseUrl: string
  apiKey?: string
  /** 嵌入模型名（如 bge-m3 / nomic-embed-text / text-embedding-v3）。必填。 */
  model: string
  timeoutMs?: number
  /** 期望维度（仅信息用途；实际以服务端返回向量长度为准）。 */
  dim?: number
  /** 单次 HTTP 请求最多携带的文本条数（默认 64）。 */
  maxBatch?: number
}

const DEFAULT_EMBED_TIMEOUT_MS = 30_000
const DEFAULT_EMBED_MAX_BATCH = 64

/** 真实嵌入模型适配器：OpenAI 兼容 POST {baseUrl}/embeddings。 */
export class OpenAIEmbedder implements Embedder {
  private readonly baseUrl: string
  private readonly apiKey?: string
  private readonly model: string
  private readonly timeoutMs: number
  private readonly maxBatch: number
  private discoveredDim = 0
  private readonly configuredDim: number

  constructor(options: OpenAIEmbedderOptions) {
    if (!options.baseUrl || !/^https?:\/\//i.test(options.baseUrl)) {
      throw new Error(`OpenAIEmbedder: 非法 baseUrl "${options.baseUrl}"`)
    }
    if (!options.model || !options.model.trim()) {
      throw new Error('OpenAIEmbedder: model 不能为空（设置 SOULVIKING_EMBED_MODEL）')
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    if (options.apiKey) this.apiKey = options.apiKey
    this.model = options.model.trim()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS
    this.maxBatch = options.maxBatch ?? DEFAULT_EMBED_MAX_BATCH
    this.configuredDim = options.dim ?? 0
  }

  get dim(): number {
    return this.discoveredDim || this.configuredDim
  }

  async embed(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text])
    return vec
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    return enqueueEmbedSerial(() => this.doEmbedBatch(texts))
  }

  private async doEmbedBatch(texts: string[]): Promise<number[][]> {
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += this.maxBatch) {
      const chunk = texts.slice(i, i + this.maxBatch)
      const vectors = await this.request(chunk)
      out.push(...vectors)
    }
    return out
  }

  private async request(texts: string[]): Promise<number[][]> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`嵌入服务请求失败（${this.baseUrl}/embeddings, model=${this.model}）：${reason}`)
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 500)
      throw new Error(`嵌入服务返回 HTTP ${response.status}：${body}`)
    }

    const payload = (await response.json()) as {
      data?: Array<{ index?: number; embedding?: number[] }>
    }
    const data = Array.isArray(payload.data) ? payload.data : []
    if (data.length !== texts.length) {
      throw new Error(`嵌入服务返回条数不符：期望 ${texts.length}，实际 ${data.length}`)
    }
    // 按 index 归位（部分服务不保证顺序），并做基本校验 + L2 归一化。
    const ordered = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    const vectors = ordered.map((item) => {
      const vec = item.embedding
      if (!Array.isArray(vec) || vec.length === 0 || vec.some((x) => typeof x !== 'number' || !Number.isFinite(x))) {
        throw new Error('嵌入服务返回了非法向量（非有限数值数组）')
      }
      return l2normalize(vec)
    })
    this.discoveredDim = vectors[0].length
    return vectors
  }
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/**
 * 按环境变量选择实现：
 * - 设置 SOULVIKING_EMBED_URL -> OpenAIEmbedder（真实模型；SOULVIKING_EMBED_MODEL 必填）
 * - 未设置               -> HashingEmbedder（维度 SOULVIKING_EMBED_DIM，默认 256）
 */
export function createEmbedder(dim?: number): Embedder {
  const fromEnv = Number(process.env.SOULVIKING_EMBED_DIM)
  const resolvedDim = dim ?? (Number.isFinite(fromEnv) && fromEnv >= 8 ? fromEnv : 256)

  const url = process.env.SOULVIKING_EMBED_URL?.trim()
  if (url) {
    const model = process.env.SOULVIKING_EMBED_MODEL?.trim()
    if (!model) {
      throw new Error(
        '已设置 SOULVIKING_EMBED_URL，但缺少 SOULVIKING_EMBED_MODEL（嵌入模型名，如 bge-m3）。' +
          '两者必须同时配置；不想用远程嵌入请取消 SOULVIKING_EMBED_URL。',
      )
    }
    const timeout = Number(process.env.SOULVIKING_EMBED_TIMEOUT_MS)
    return new OpenAIEmbedder({
      baseUrl: url,
      ...(process.env.SOULVIKING_EMBED_API_KEY ? { apiKey: process.env.SOULVIKING_EMBED_API_KEY } : {}),
      model,
      ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutMs: timeout } : {}),
      ...(Number.isFinite(fromEnv) && fromEnv >= 8 ? { dim: fromEnv } : {}),
    })
  }
  return new HashingEmbedder(resolvedDim)
}
