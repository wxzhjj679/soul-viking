// 嵌入层测试：OpenAIEmbedder（批量/归一化/串行互斥/错误处理）、
// createEmbedder 环境变量选择、以及切换嵌入模型后的跨向量空间防护。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEmbedder, HashingEmbedder, OpenAIEmbedder } from '../core/embed.ts'
import { VikingStore } from '../core/viking/store.ts'

const EMBED_DIM = 8

/** 确定性伪向量：由文本字符码派生（服务端模拟用，非归一化，客户端应自行归一化）。 */
function pseudoVec(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(1)
  for (let i = 0; i < text.length; i += 1) v[i % EMBED_DIM] += text.charCodeAt(i) % 7
  return v
}

interface MockServer {
  server: Server
  port: number
  requestCount: () => number
  maxInFlight: () => number
  close: () => Promise<void>
}

async function startEmbedServer(options: { delayMs?: number; failWith?: number } = {}): Promise<MockServer> {
  let requests = 0
  let inFlight = 0
  let maxInFlight = 0
  const server: Server = createServer((req, res) => {
    requests += 1
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })
    req.on('end', () => {
      const respond = (): void => {
        inFlight -= 1
        if (options.failWith) {
          res.statusCode = options.failWith
          res.end('boom')
          return
        }
        const parsed = JSON.parse(body) as { input: string[] }
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            data: parsed.input.map((text, index) => ({ index, embedding: pseudoVec(text) })),
          }),
        )
      }
      if (options.delayMs) setTimeout(respond, options.delayMs)
      else respond()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  return {
    server,
    port,
    requestCount: () => requests,
    maxInFlight: () => maxInFlight,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

test('OpenAIEmbedder：批量合请求 + L2 归一化 + 维度自动发现', async () => {
  const mock = await startEmbedServer()
  try {
    const embedder = new OpenAIEmbedder({ baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'test-embed' })
    const vectors = await embedder.embedBatch(['深色主题', '大字号界面', '函数式风格'])
    assert.equal(vectors.length, 3)
    assert.equal(mock.requestCount(), 1, '3 条文本应合并为 1 次 HTTP 请求')
    assert.equal(embedder.dim, EMBED_DIM, '维度应从服务端响应自动发现')
    for (const vec of vectors) {
      assert.equal(vec.length, EMBED_DIM)
      const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0))
      assert.ok(Math.abs(norm - 1) < 1e-9, '向量必须 L2 归一化')
    }
    // 单条接口与批量一致
    const single = await embedder.embed('深色主题')
    assert.deepEqual(single, vectors[0])
  } finally {
    await mock.close()
  }
})

test('OpenAIEmbedder：并发调用串行互斥（本地 GPU 保护）', async () => {
  const mock = await startEmbedServer({ delayMs: 30 })
  try {
    const embedder = new OpenAIEmbedder({ baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'test-embed' })
    const results = await Promise.all([
      embedder.embed('a'),
      embedder.embedBatch(['b', 'c']),
      embedder.embed('d'),
    ])
    assert.equal(results.length, 3)
    assert.equal(mock.maxInFlight(), 1, `期望严格串行，实际最大并发 ${mock.maxInFlight()}`)
  } finally {
    await mock.close()
  }
})

test('OpenAIEmbedder：服务端错误显式抛错，不静默降级', async () => {
  const mock = await startEmbedServer({ failWith: 503 })
  try {
    const embedder = new OpenAIEmbedder({ baseUrl: `http://127.0.0.1:${mock.port}/v1`, model: 'test-embed' })
    await assert.rejects(() => embedder.embed('任意文本'), /HTTP 503/)
  } finally {
    await mock.close()
  }
})

test('createEmbedder：按环境变量选择实现，缺 MODEL 时快速失败', () => {
  const saved = { ...process.env }
  try {
    delete process.env.SOULVIKING_EMBED_URL
    delete process.env.SOULVIKING_EMBED_MODEL
    assert.ok(createEmbedder() instanceof HashingEmbedder, '未设 URL 应回落 hashing')

    process.env.SOULVIKING_EMBED_URL = 'http://127.0.0.1:9/v1'
    assert.throws(() => createEmbedder(), /SOULVIKING_EMBED_MODEL/, '设了 URL 缺 MODEL 必须报错而不是静默降级')

    process.env.SOULVIKING_EMBED_MODEL = 'bge-m3'
    assert.ok(createEmbedder() instanceof OpenAIEmbedder)
  } finally {
    process.env = saved
  }
})

test('跨向量空间防护：切换嵌入维度后旧向量不参与检索/冲突判定', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sv-reembed-'))
  const dbPath = join(dir, 'viking.db')
  try {
    const storeA = new VikingStore({ dbPath, embedder: new HashingEmbedder(256) })
    await storeA.storeMemory('用户偏好深色主题界面。', 'viking://memories/user/theme')
    storeA.close()

    // 模拟切换到不同维度的嵌入模型：旧 256 维向量必须被跳过（返回空而非伪分数）
    const storeB = new VikingStore({ dbPath, embedder: new HashingEmbedder(64) })
    const hits = await storeB.search('深色主题 界面', 10)
    assert.equal(hits.length, 0, '维度不符的旧向量不应参与检索')

    // 写入新向量空间的记忆后，新空间内部检索正常，且不与旧向量发生伪冲突
    await storeB.storeMemory('用户偏好深色主题界面。', 'viking://memories/user/theme-v2')
    const newHits = await storeB.search('深色主题 界面', 10)
    assert.ok(newHits.some((h) => h.uri === 'viking://memories/user/theme-v2'))
    const stored = storeB.get('viking://memories/user/theme-v2')
    assert.equal(stored?.supersededBy, null, '跨空间不得误标 superseded')
    storeB.close()

    // 原维度重新打开，旧记忆恢复可检索
    const storeC = new VikingStore({ dbPath, embedder: new HashingEmbedder(256) })
    const oldHits = await storeC.search('深色主题 界面', 10)
    assert.ok(oldHits.some((h) => h.uri === 'viking://memories/user/theme'))
    storeC.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
