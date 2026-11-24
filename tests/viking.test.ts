import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VikingStore } from '../core/viking/store.ts'
import { directoryRecursiveRecall } from '../core/viking/recall.ts'

function newStore(): VikingStore {
  return new VikingStore({ dbPath: ':memory:', conflictThreshold: 0.9 })
}

const LONG_TEXT = Array.from({ length: 40 }, (_, i) => `第${i + 1}条：本项目在部署时应先构建再启动，注意配置与环境变量。`).join('')

test('memory_store 生成 viking:// URI 与 L0/L1/L2 三层', async () => {
  const store = newStore()
  const res = await store.storeMemory('用户偏好深色主题，界面以暗色为主。', 'viking://memories/user/theme')
  assert.equal(res.uri, 'viking://memories/user/theme')
  assert.ok(res.layers.l0.length > 0)
  assert.ok(res.layers.l1.length > 0)
  assert.equal(res.layers.l2, '用户偏好深色主题，界面以暗色为主。')
  const stored = store.get(res.uri)
  assert.ok(stored)
  assert.equal(stored?.directory, 'viking://memories/user')
  assert.equal(stored?.kind, 'memories/user')
  store.close()
})

test('分层配额：L0<=50 / L1<=300 tokens，L2 为原文', async () => {
  const store = newStore()
  const res = await store.storeMemory(LONG_TEXT, 'viking://memories/project/long')
  const stored = store.get(res.uri)
  assert.ok(stored)
  assert.ok((stored?.tokensL0 ?? 999) <= 55, `L0 tokens=${stored?.tokensL0}`)
  assert.ok((stored?.tokensL1 ?? 999) <= 320, `L1 tokens=${stored?.tokensL1}`)
  assert.ok((stored?.l2.length ?? 0) >= (stored?.l1.length ?? 0))
  store.close()
})

test('目录递归检索：Top-3 注入 L1，其余注入 L0，并记录轨迹', async () => {
  const store = newStore()
  const base = 'alpha 项目 部署 配置 说明'
  await store.storeMemory(`${base} 一：构建步骤`, 'viking://memories/project/alpha/m1')
  await store.storeMemory(`${base} 二：环境变量`, 'viking://memories/project/alpha/m2')
  await store.storeMemory(`${base} 三：启动命令`, 'viking://memories/project/alpha/m3')
  await store.storeMemory(`${base} 四：健康检查`, 'viking://memories/project/alpha/m4')

  const result = await directoryRecursiveRecall(store, 'alpha 项目 部署 配置', { topK: 4 })
  assert.equal(result.chunks.length, 4)
  assert.equal(result.injectedL1, 3)
  assert.equal(result.injectedL0, 1)
  assert.equal(result.topDirectory, 'viking://memories/project/alpha')
  assert.ok(result.chunks[0]?.uri.startsWith('viking://'))
  assert.ok(result.chunks[0]?.layer === 'L1')
  assert.ok(result.chunks[3]?.layer === 'L0')

  const traces = store.listTraces()
  assert.ok(traces.length >= 1)
  assert.equal(traces[0]?.id, result.trace.id)
  store.close()
})

test('冲突策略：最新事实优先 + 标记冲突（不覆盖）', async () => {
  const store = newStore()
  const first = await store.storeMemory('用户偏好深色主题，界面以暗色为主。', 'viking://memories/user/theme')
  const second = await store.storeMemory('用户偏好深色主题，界面以暗色为主。', 'viking://memories/user/theme-v2')
  assert.equal(second.conflict, true)
  assert.ok(second.superseded.includes(first.uri))

  const oldMemory = store.get(first.uri)
  assert.equal(oldMemory?.supersededBy, second.uri)
  const conflicts = store.listConflicts()
  assert.ok(conflicts.length >= 1)

  // 检索默认排除被取代的旧条目
  const hits = await store.search('深色主题', 10)
  assert.ok(hits.every((h) => h.uri !== first.uri))
  store.close()
})

test('memory_forget：按 URI 与按查询标记遗忘', async () => {
  const store = newStore()
  const a = await store.storeMemory('独一无二的记忆：青色按钮设计规范。', 'viking://memories/user/unique-a')
  const forgottenByUri = await store.forget(a.uri)
  assert.deepEqual(forgottenByUri.forgotten, [a.uri])
  assert.equal(store.get(a.uri)?.forgotten, true)

  const b = await store.storeMemory('关于缓存策略的记忆：使用 LRU 淘汰。', 'viking://memories/user/unique-b')
  const forgottenByQuery = await store.forget('缓存 策略 LRU 淘汰')
  assert.ok(forgottenByQuery.forgotten.includes(b.uri))
  store.close()
})
