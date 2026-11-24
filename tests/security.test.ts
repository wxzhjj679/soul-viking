// 安全修复回归测试：owner 记忆隔离 + 模型请求串行互斥。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { VikingStore } from '../core/viking/store.ts'
import { OpenAICompatibleModel } from '../core/llm.ts'

test('owner 隔离：A 的私有记忆对 B 不可见，全局记忆对所有人可见', async () => {
  const store = new VikingStore({ dbPath: ':memory:' })
  try {
    await store.storeMemory('用户 A 的密钥轮换计划：每 30 天一次。', 'viking://memories/user/secret-a', [], 'alice')
    await store.storeMemory('团队公共约定：提交信息用中文。', 'viking://memories/team/convention')

    const asAlice = await store.search('密钥 轮换', 10, 'alice')
    assert.ok(asAlice.some((h) => h.uri === 'viking://memories/user/secret-a'))

    const asBob = await store.search('密钥 轮换', 10, 'bob')
    assert.ok(!asBob.some((h) => h.uri === 'viking://memories/user/secret-a'), 'B 不应检索到 A 的私有记忆')

    const globalVisible = await store.search('提交信息 约定', 10, 'bob')
    assert.ok(globalVisible.some((h) => h.uri === 'viking://memories/team/convention'))

    // forget 同样受 owner 约束：bob 无法遗忘 alice 的记忆
    const bobForget = await store.forget('viking://memories/user/secret-a', 'bob')
    assert.equal(bobForget.forgotten.length, 0)
    const aliceForget = await store.forget('viking://memories/user/secret-a', 'alice')
    assert.deepEqual(aliceForget.forgotten, ['viking://memories/user/secret-a'])
  } finally {
    store.close()
  }
})

test('模型串行互斥：并发调用同一时间只有一个请求在途', async () => {
  let inFlight = 0
  let maxInFlight = 0
  const server: Server = createServer((_req, res) => {
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    // 故意异步延迟，制造并发窗口
    setTimeout(() => {
      inFlight -= 1
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
    }, 30)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as { port: number }
  try {
    const model = new OpenAICompatibleModel(`http://127.0.0.1:${port}/v1`, undefined, 5000)
    const request = { model: 'test', messages: [{ role: 'user' as const, content: 'hi' }] }
    const replies = await Promise.all([model.chat(request), model.chat(request), model.chat(request)])
    assert.deepEqual(replies, ['ok', 'ok', 'ok'])
    assert.equal(maxInFlight, 1, `期望严格串行，实际最大并发 ${maxInFlight}`)
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
})
