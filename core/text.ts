// 文本与分层工具：token 估算、句子切分、抽取式摘要/截断。
// 设计原则：不依赖任何外部模型。L0/L1 由确定性抽取式摘要生成，L2 保存原文。

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯]/

export function isCjkChar(ch: string): boolean {
  return CJK_RE.test(ch)
}

/**
 * 估算 token 数：CJK 字符按 1 token 计，其余字符按每 4 字符 1 token 计。
 * 这是与真实分词器解耦的保守近似，用于分层配额控制。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let cjk = 0
  let restLen = 0
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk += 1
    else restLen += 1
  }
  return cjk + Math.ceil(restLen / 4)
}

/** 按中英文句末标点切句，保留分隔尾巴，过滤空句。 */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return []
  const parts = normalized.split(/(?<=[。！？!?.;;])/u).map((s) => s.trim()).filter(Boolean)
  return parts.length > 0 ? parts : [normalized]
}

function hardTruncate(text: string, maxTokens: number): string {
  let out = ''
  for (const ch of text) {
    if (estimateTokens(out + ch) > maxTokens) break
    out += ch
  }
  return out || text.slice(0, Math.max(1, maxTokens))
}

/**
 * 抽取式摘要：按句累积直到接近 token 配额。用于生成 L1（≤300）/L0（≤50）。
 * 单句过长时退化为按字符硬截断。绝不引入伪造内容。
 */
export function summarizeExtractive(text: string, maxTokens: number): string {
  const sentences = splitSentences(text)
  if (sentences.length === 0) return ''
  let out = ''
  for (const sentence of sentences) {
    const candidate = out ? `${out} ${sentence}` : sentence
    if (out && estimateTokens(candidate) > maxTokens) break
    out = candidate
    if (estimateTokens(out) >= maxTokens) break
  }
  if (!out) out = hardTruncate(text, maxTokens)
  if (estimateTokens(out) > maxTokens) out = hardTruncate(out, maxTokens)
  return out
}

/** 生成三层表示。L2 为原文；L1 ≤300 tokens；L0 ≤50 tokens。 */
export interface LayeredText {
  l0: string
  l1: string
  l2: string
  tokensL0: number
  tokensL1: number
}

export function buildLayers(text: string): LayeredText {
  const l2 = text.trim()
  const l1 = summarizeExtractive(l2, 300)
  const l0 = summarizeExtractive(l2, 50)
  return {
    l0,
    l1,
    l2,
    tokensL0: estimateTokens(l0),
    tokensL1: estimateTokens(l1),
  }
}
