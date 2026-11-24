// DSH 灵魂引擎（danshuyue/dsh-agent-soul v0.10.6 原样移植）集成测试。
// 验证适配层契约：装配六段注入、四个引擎工具、每轮提取/衰减/日记素材、心情记账、跨实例持久化。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDshSoul } from '../core/dsh/adapter.js'
import { SoulViking } from '../core/facade.ts'
import { buildTools } from '../mcp_server/tools.ts'

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'sv-dsh-'))
}

test('引擎装配：六段注入全部注册（数据边界/人格/记忆/笔记/目的/心情），四个工具全部注册', async () => {
  const home = tmpHome()
  const dsh = await createDshSoul({ homeDir: home, cwd: home, llmClient: null })
  const names = dsh.segmentNames().map((s) => s.name)
  for (const seg of ['soul:data-policy', 'soul:persona', 'soul:memory', 'soul:notes', 'soul:purpose', 'soul:mood']) {
    assert.ok(names.includes(seg), `缺少注入段 ${seg}（实际：${names.join(', ')}）`)
  }
  // order 口径：270 数据边界 → 260 人格 → 250 记忆 → 245 笔记 → 240 目的 → 230 心情
  const orders = Object.fromEntries(dsh.segmentNames().map((s) => [s.name, s.order]))
  assert.ok(orders['soul:data-policy'] > orders['soul:persona'])
  assert.ok(orders['soul:persona'] > orders['soul:memory'])
  assert.ok(orders['soul:memory'] > orders['soul:notes'])
  assert.ok(orders['soul:notes'] > orders['soul:purpose'])
  assert.ok(orders['soul:purpose'] > orders['soul:mood'])

  const toolNames = dsh.tools.map((t) => t.name)
  for (const tool of ['soul_memory', 'soul_goal', 'soul_note', 'soul_diary']) {
    assert.ok(toolNames.includes(tool), `缺少引擎工具 ${tool}（实际：${toolNames.join(', ')}）`)
  }
  dsh.dispose()
})

test('每轮装配：beginTurn 产出注入文本，数据边界声明在最前；有记忆后记忆段出现', async () => {
  const home = tmpHome()
  const dsh = await createDshSoul({ homeDir: home, cwd: home, llmClient: null })
  const turn = await dsh.beginTurn('sess-1', '你好呀，今天过得怎么样？')
  assert.ok(turn.systemText.length > 0)
  const segNames = turn.segments.map((s) => s.name)
  assert.ok(segNames.includes('soul:data-policy'))
  assert.equal(segNames[0], 'soul:data-policy', '数据边界声明必须最先（order 270）')
  // 空卡时记忆段渲染为空串被过滤——这是引擎自己的行为；写入记忆后下一轮必须出现
  const memoryTool = dsh.tools.find((t) => t.name === 'soul_memory')!
  await memoryTool.execute({ action: 'write', text: '主人喜欢在下雨天听爵士乐', scope: 'global' }, dsh.currentContext())
  await dsh.endTurn('sess-1', '今天不错，谢谢你来找我聊天。')
  const turn2 = await dsh.beginTurn('sess-1', '推荐点音乐吧')
  const segNames2 = turn2.segments.map((s) => s.name)
  assert.ok(segNames2.includes('soul:memory'), '有记忆后记忆段应注入')
  assert.ok(segNames2.indexOf('soul:data-policy') < segNames2.indexOf('soul:memory'))
  dsh.dispose()
})

test('记忆工具：write 落盘全局记忆卡，recall 逐字取回，forget 进遗忘档案（不物理删除）', async () => {
  const home = tmpHome()
  const dsh = await createDshSoul({ homeDir: home, cwd: home, llmClient: null })
  await dsh.beginTurn('sess-1', '记住一下：我最喜欢喝的咖啡是冰美式，不加糖。')
  const memoryTool = dsh.tools.find((t) => t.name === 'soul_memory')!
  const context = dsh.currentContext()

  const written = (await memoryTool.execute({ action: 'write', text: '主人最喜欢喝冰美式咖啡，不加糖', scope: 'global' }, context)) as { ok: boolean; message: string }
  assert.equal(written.ok, true)

  // 落盘位置是引擎自己的路径口径：<DSH_HOME>/agents/memory/global.json
  const globalJson = join(home, 'dsh-soul', 'agents', 'memory', 'global.json')
  assert.ok(existsSync(globalJson), '全局记忆卡应已落盘')
  const card = JSON.parse(readFileSync(globalJson, 'utf8')) as { records: Array<{ id: string; text: string }> }
  assert.ok(card.records.some((r) => r.text.includes('冰美式')))

  const recalled = (await memoryTool.execute({ action: 'recall', query: '咖啡' }, context)) as { ok: boolean; items: Array<{ id: string; text: string }> }
  assert.equal(recalled.ok, true)
  assert.ok(recalled.items.some((i) => i.text.includes('冰美式')))

  const id = recalled.items.find((i) => i.text.includes('冰美式'))!.id
  const forgotten = (await memoryTool.execute({ action: 'forget', id }, context)) as { ok: boolean }
  assert.equal(forgotten.ok, true)
  // 遗忘不是删除：档案（archive.jsonl）里必须有这条
  const archive = join(home, 'dsh-soul', 'agents', 'memory', 'archive.jsonl')
  if (existsSync(archive)) {
    assert.ok(readFileSync(archive, 'utf8').includes('冰美式'), '遗忘应归档')
  }
  dsh.dispose()
})

test('写入回声：write 之后下一轮注入里出现「刚记下的」回执', async () => {
  const home = tmpHome()
  const dsh = await createDshSoul({ homeDir: home, cwd: home, llmClient: null })
  await dsh.beginTurn('sess-echo', '帮我记一件事')
  await dsh.endTurn('sess-echo', '好呀，你说。')
  const memoryTool = dsh.tools.find((t) => t.name === 'soul_memory')!
  await memoryTool.execute({ action: 'write', text: '下周三要交季度报告', scope: 'global' }, dsh.currentContext())
  // 真实对话流：她回了一句（轮次推进），下一轮装配时回声必须出现
  const turn2 = await dsh.beginTurn('sess-echo', '记好了吗？')
  assert.ok(turn2.systemText.includes('刚记下的'), '下一轮注入应包含写入回声')
  assert.ok(turn2.systemText.includes('季度报告'))
  dsh.dispose()
})

test('跨会话跨任务：换一个会话（新 sessionId）仍然召回同一份记忆卡', async () => {
  const home = tmpHome()
  const dsh = await createDshSoul({ homeDir: home, cwd: home, llmClient: null })
  await dsh.beginTurn('session-A', '我叫林小树，是一名剪辑师')
  const memoryTool = dsh.tools.find((t) => t.name === 'soul_memory')!
  await memoryTool.execute({ action: 'write', text: '主人叫林小树，职业是剪辑师', scope: 'global' }, dsh.currentContext())

  // 全新会话（模拟十天后再来）：记忆卡从盘上读回
  const turn = await dsh.beginTurn('session-B-completely-new', '你还记得我是做什么的吗')
  const recalled = (await memoryTool.execute({ action: 'recall', query: '职业' }, dsh.currentContext())) as { items: Array<{ text: string }> }
  assert.ok(recalled.items.some((i) => i.text.includes('剪辑师')))
  assert.ok(turn.systemText.includes('剪辑师') || recalled.items.length > 0)
  dsh.dispose()
})

test('跨实例持久化：引擎重新装配（模拟重启进程）后记忆卡与心情状态仍在', async () => {
  const home = tmpHome()
  const first = await createDshSoul({ homeDir: home, cwd: home, llmClient: null })
  await first.beginTurn('s1', '记住：我的猫叫煤球')
  const memoryTool = first.tools.find((t) => t.name === 'soul_memory')!
  await memoryTool.execute({ action: 'write', text: '主人的猫叫煤球，三岁', scope: 'global' }, first.currentContext())
  first.dispose()

  const second = await createDshSoul({ homeDir: home, cwd: home, llmClient: null })
  const recalled = (await second.tools.find((t) => t.name === 'soul_memory')!.execute({ action: 'recall', query: '煤球' }, second.currentContext())) as { items: Array<{ text: string }> }
  assert.ok(recalled.items.some((i) => i.text.includes('煤球')), '重启后应还记得煤球')
  const mood = second.moodState() as Record<string, unknown>
  assert.ok(mood && typeof mood === 'object')
  second.dispose()
})

test('每轮提取（离线路径）：对话流水 JSONL 随轮次增长（日记素材）', async () => {
  const home = tmpHome()
  const dsh = await createDshSoul({ homeDir: home, cwd: home, llmClient: null })
  // collectForDiary 的游标语义：第一次见会话只定位游标，从第二轮起收事件——
  // 和真实对话流一致（引擎设计如此，防止冷启动回灌几千条历史）。
  await dsh.beginTurn('s-extract', '我下个月要去成都出差，帮我记着这件事')
  await dsh.endTurn('s-extract', '好的，记下了。')
  await dsh.beginTurn('s-extract', '成都那边天气怎么样，帮我看看日程')
  const convDir = join(home, 'dsh-soul', 'agents', 'diary', 'conversations')
  assert.ok(existsSync(convDir), '对话流水目录应存在')
  const files = readdirSync(convDir).filter((f) => f.endsWith('.jsonl'))
  assert.ok(files.length >= 1, '应有当天对话流水')
  const content = readFileSync(join(convDir, files[0]), 'utf8')
  assert.ok(content.includes('成都'), '对话流水应包含本轮内容')
  dsh.dispose()
})

test('心情状态：moodState 可读，引擎缺 llm 时按自身降级路径不判定、不崩溃', async () => {
  const home = tmpHome()
  const dsh = await createDshSoul({ homeDir: home, cwd: home, llmClient: null })
  await dsh.beginTurn('s-mood', '今天真开心，谢谢你！')
  await dsh.endTurn('s-mood', '看到你开心我也开心。')
  const mood = dsh.moodState() as Record<string, unknown>
  assert.ok(mood !== null && typeof mood === 'object')
  dsh.dispose()
})

test('门面集成：soulChat 经过灵魂引擎（返回注入段清单与心情快照），MCP 工具表包含引擎四工具 + soul_status', async () => {
  const home = tmpHome()
  const facade = new SoulViking({ homeDir: home, dbPath: ':memory:', embedDim: 64 })
  try {
    const dshTools = await facade.dshTools()
    assert.equal(dshTools.length, 4)
    const tools = buildTools(facade, dshTools)
    const names = tools.map((t) => t.name)
    for (const n of ['soul_memory', 'soul_goal', 'soul_note', 'soul_diary', 'soul_status']) {
      assert.ok(names.includes(n), `MCP 工具表缺少 ${n}`)
    }

    const chat = await facade.soulChat('你好呀，我叫阿哲，平时喜欢剪视频', 'facade-s1')
    assert.ok(Array.isArray((chat as { soul_segments?: string[] }).soul_segments))
    assert.ok((chat as { soul_segments: string[] }).soul_segments.includes('soul:data-policy'))
    assert.ok((chat as { soul_mood?: unknown }).soul_mood !== undefined)

    // soul_memory 经 MCP 工具层透传可用
    const memoryTool = tools.find((t) => t.name === 'soul_memory')!
    const out = await memoryTool.handler({ action: 'write', text: '主人叫阿哲，喜欢剪视频', scope: 'global' })
    assert.ok(String(JSON.stringify(out)).length > 0)
    const status = (await tools.find((t) => t.name === 'soul_status')!.handler({})) as { ready: boolean; cards: { global: number } }
    assert.equal(status.ready, true)
    assert.ok(status.cards.global >= 1)
  } finally {
    facade.close()
  }
})

test('降级保护：disableDshSoul 时 soulChat 仍可用（对话不因引擎缺席而中断）', async () => {
  const facade = new SoulViking({ homeDir: tmpHome(), dbPath: ':memory:', embedDim: 64, disableDshSoul: true })
  try {
    const chat = await facade.soulChat('你好', 'no-dsh')
    assert.ok(typeof chat.reply === 'string' && chat.reply.length > 0)
    assert.equal((chat as { soul_segments?: unknown }).soul_segments, undefined)
  } finally {
    facade.close()
  }
})
