import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SoulViking } from '../core/facade.ts'
import { buildTools } from '../mcp_server/tools.ts'
import { serveStdio } from '../mcp_server/protocol.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function makeClient() {
  const facade = new SoulViking({
    dbPath: ':memory:',
    soulsDir: join(ROOT, 'souls'),
    skillsRegistryPath: join(ROOT, 'skills', 'registry.json'),
    defaultPersonaId: 'software-engineer',
  })
  const tools = buildTools(facade)
  const input = new PassThrough()
  const output = new PassThrough()
  let buffer = ''
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
  })
  serveStdio({ name: 'soul-viking', version: '0.1.0', tools }, { stdin: input, stdout: output })

  const send = (obj: unknown): void => {
    input.write(`${JSON.stringify(obj)}\n`)
  }
  const waitFor = async (count: number, timeoutMs = 3000): Promise<void> => {
    const start = Date.now()
    while (buffer.split('\n').filter(Boolean).length < count) {
      if (Date.now() - start > timeoutMs) throw new Error(`等待响应超时，已有：${buffer}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const messages = (): Array<Record<string, unknown>> =>
    buffer
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  return { facade, tools, send, waitFor, messages }
}

test('initialize 返回协议版本与服务信息，tools/list 暴露全部工具', async () => {
  const client = makeClient()
  client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  await client.waitFor(2)
  const msgs = client.messages()
  const init = msgs.find((m) => m.id === 1)
  assert.equal((init?.result as { protocolVersion?: string })?.protocolVersion, '2025-06-18')
  assert.equal((init?.result as { serverInfo?: { name?: string } })?.serverInfo?.name, 'soul-viking')

  const list = msgs.find((m) => m.id === 2)
  const toolsList = (list?.result as { tools?: unknown[] })?.tools ?? []
  // 16 个静态工具 + soul_status（DSH 引擎观测面）；引擎四工具由 index.ts 运行期动态并入
  assert.equal(toolsList.length, 17)

  // 必需的 MCP 工具签名都在
  const names = new Set(
    ((list?.result as { tools?: Array<{ name: string }> })?.tools ?? []).map((t) => t.name),
  )
  for (const requiredName of [
    'soul_chat',
    'soul_switch_persona',
    'soul_recall',
    'soul_remember',
    'memory_recall',
    'memory_store',
    'memory_forget',
    'skill_list',
    'skill_route',
    'skill_execute',
    'verify_register_task',
    'verify_run',
    'verify_evidence',
    'soul_viking_handle',
    'soul_status',
  ]) {
    assert.ok(names.has(requiredName), `缺少工具 ${requiredName}`)
  }
  // 团队协作类工具必须不存在（团队归宿主侧 DSH 插件管，MCP 不管理团队）
  for (const forbidden of ['team_spawn', 'team_orchestrate', 'team_list_souls', 'team_wake_lead', 'echo_now', 'vital_status']) {
    assert.ok(!names.has(forbidden), `瘦身后的 MCP 不应再有 ${forbidden}`)
  }
  client.facade.close()
})

test('tools/call 端到端：memory_store 后 memory_recall 命中并带 viking URI', async () => {
  const client = makeClient()
  client.send({
    jsonrpc: '2.0',
    id: 10,
    method: 'tools/call',
    params: {
      name: 'memory_store',
      arguments: { text: '用户偏好深色主题界面，喜欢大字号。', uri: 'viking://memories/user/prefs' },
    },
  })
  client.send({
    jsonrpc: '2.0',
    id: 11,
    method: 'tools/call',
    params: { name: 'memory_recall', arguments: { query: '界面 主题 偏好', top_k: 5 } },
  })
  await client.waitFor(2)
  const msgs = client.messages()
  const storeResp = msgs.find((m) => m.id === 10)
  const storeText = (storeResp?.result as { content?: Array<{ text: string }> })?.content?.[0]?.text ?? '{}'
  const stored = JSON.parse(storeText) as { uri: string; layers: { l2: string } }
  assert.equal(stored.uri, 'viking://memories/user/prefs')

  const recallResp = msgs.find((m) => m.id === 11)
  const recallText = (recallResp?.result as { content?: Array<{ text: string }> })?.content?.[0]?.text ?? '{}'
  const recalled = JSON.parse(recallText) as { chunks: Array<{ uri: string; layer: string }> }
  assert.ok(recalled.chunks.length > 0)
  assert.ok(recalled.chunks[0]?.uri.startsWith('viking://'))
  client.facade.close()
})

test('错误处理：未知方法 -> JSON-RPC 错误；未知工具 -> isError 结果', async () => {
  const client = makeClient()
  client.send({ jsonrpc: '2.0', id: 20, method: 'does/not/exist' })
  client.send({ jsonrpc: '2.0', id: 21, method: 'tools/call', params: { name: 'nope', arguments: {} } })
  await client.waitFor(2)
  const msgs = client.messages()
  const errResp = msgs.find((m) => m.id === 20)
  assert.equal((errResp?.error as { code?: number })?.code, -32601)
  const toolResp = msgs.find((m) => m.id === 21)
  assert.equal((toolResp?.result as { isError?: boolean })?.isError, true)
  client.facade.close()
})

test('技能派发工具可经 MCP 调用：skill_execute 返回派发指引（调度员定位）', async () => {
  const client = makeClient()
  client.send({ jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'skill_list', arguments: {} } })
  client.send({
    jsonrpc: '2.0',
    id: 32,
    method: 'tools/call',
    params: { name: 'skill_execute', arguments: { skill: 'video-editor' } },
  })
  await client.waitFor(2)
  const msgs = client.messages()

  const listText = (msgs.find((m) => m.id === 30)?.result as { content?: Array<{ text: string }> })?.content?.[0]
    ?.text ?? '[]'
  assert.ok((JSON.parse(listText) as unknown[]).length >= 1)

  const execText = (msgs.find((m) => m.id === 32)?.result as { content?: Array<{ text: string }> })?.content?.[0]
    ?.text ?? '{}'
  const exec = JSON.parse(execText) as { requires_verification: boolean; status: string; dispatch: { kind: string } }
  assert.equal(exec.status, 'dispatched')
  assert.equal(exec.requires_verification, true)
  assert.equal(exec.dispatch.kind, 'external_mcp')
  client.facade.close()
})
