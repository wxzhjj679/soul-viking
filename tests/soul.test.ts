import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectPersona, parsePersona } from '../core/soul/persona.ts'
import { SoulService } from '../core/soul/router.ts'
import { loadPersonas } from '../core/loaders.ts'
import { ModelRegistry } from '../core/llm.ts'
import type { RecallProvider } from '../core/types.ts'
import { PersonaMemoryStore } from '../core/viking/persona-memory.ts'
import { directoryRecursiveRecall } from '../core/viking/recall.ts'
import { VikingStore } from '../core/viking/store.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function makeSoul() {
  const store = new VikingStore({ dbPath: ':memory:' })
  const memory = new PersonaMemoryStore(store.db, store.embedder)
  const recall: RecallProvider = {
    recall: async (query, options) => {
      const r = await directoryRecursiveRecall(store, query, options)
      return { chunks: r.chunks, topDirectory: r.topDirectory, traceId: r.trace.id }
    },
  }
  const personas = loadPersonas(join(ROOT, 'souls'))
  const soul = new SoulService({
    personas,
    defaultPersonaId: 'software-engineer',
    memory,
    recall,
    models: new ModelRegistry(),
    embedder: store.embedder,
  })
  return { store, soul }
}

test('解析人设 Markdown frontmatter', () => {
  const md = `---\nid: demo\nname: 演示人格\ndescription: 用于测试\ninjection: append\n---\n你是演示人格。`
  const persona = parsePersona(md)
  assert.equal(persona.id, 'demo')
  assert.equal(persona.name, '演示人格')
  assert.equal(persona.injectionDefault, 'append')
  assert.equal(persona.body, '你是演示人格。')
})

test('三种注入模式均保留工具 schema 与运行时上下文', () => {
  const parts = { baseInstructions: 'BASE', toolSchema: 'TOOLS', runtimeContext: 'RUNTIME' }
  const prefer = injectPersona('PERSONA', parts, 'prefer')
  assert.ok(prefer.startsWith('PERSONA'))
  assert.ok(prefer.includes('TOOLS') && prefer.includes('RUNTIME'))

  const replace = injectPersona('PERSONA', parts, 'replace')
  assert.ok(!replace.includes('BASE'))
  assert.ok(replace.includes('TOOLS') && replace.includes('RUNTIME') && replace.includes('PERSONA'))

  const append = injectPersona('PERSONA', parts, 'append')
  assert.ok(append.includes('BASE') && append.includes('PERSONA'))
  assert.ok(append.indexOf('PERSONA') > append.indexOf('BASE'))
  assert.ok(append.includes('RUNTIME'))
})

test('会话绑定：会话级覆盖，其他会话回落默认', async () => {
  const { store, soul } = makeSoul()
  const def = await soul.chat('你好', 's-default')
  assert.equal(def.persona_id, 'software-engineer')

  soul.switchPersona('verifier', 's-a')
  const bound = await soul.chat('你好', 's-a')
  assert.equal(bound.persona_id, 'verifier')

  const other = await soul.chat('你好', 's-b')
  assert.equal(other.persona_id, 'software-engineer')
  store.close()
})

test('注入模式在 chat 中生效，且召回记忆带 viking URI', async () => {
  const { store, soul } = makeSoul()
  await store.storeMemory('用户偏好深色主题界面，喜欢大字号。', 'viking://memories/user/theme')
  const res = await soul.chat('界面主题偏好是什么', 's1', 'replace')
  assert.equal(res.injectionMode, 'replace')
  assert.ok(res.memory_used.length > 0)
  assert.ok(res.memory_used.every((uri) => uri.startsWith('viking://')))
  store.close()
})

test('人设私有记忆：写入与召回带 viking:// URI', async () => {
  const { store, soul } = makeSoul()
  const item = await soul.remember('software-engineer', 'preference', '偏好函数式风格')
  assert.ok(item.uri?.startsWith('viking://souls/software-engineer/memory/'))
  const recalled = await soul.recall('software-engineer', '函数式 风格')
  assert.ok(recalled.length > 0)
  assert.ok(recalled[0]?.uri?.startsWith('viking://'))
  store.close()
})

test('会话结束记忆审核：阈值门禁与去重', async () => {
  const { store, soul } = makeSoul()
  const transcript = '我喜欢简洁的界面，记住用深色主题。'
  const suggestions = await soul.reviewSession('s1', transcript)
  assert.ok(suggestions.length > 0)
  assert.ok(suggestions[0]?.category === 'preference')

  const applied = await soul.applyReview('software-engineer', suggestions, { threshold: 0.6 })
  assert.ok(applied.applied.length > 0)

  // 再次审核应识别为去重
  const again = await soul.reviewSession('s1', transcript)
  assert.ok(again.some((s) => s.action === 'dedupe'))

  // 高阈值 + 未确认 -> 全部跳过
  const strict = await soul.applyReview('software-engineer', suggestions, { threshold: 0.99, confirmed: false })
  assert.equal(strict.applied.length, 0)
  store.close()
})

test('Soul 层隔离：不 import 文件系统/命令执行模块', () => {
  const dir = join(ROOT, 'core', 'soul')
  const forbidden = [/from\s+['"](?:node:)?(?:fs|child_process)['"]/, /require\(\s*['"](?:node:)?(?:fs|child_process)['"]\s*\)/, /\b(writeFileSync|execSync|spawnSync)\b/]
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(join(dir, file), 'utf8')
    for (const re of forbidden) {
      assert.ok(!re.test(source), `core/soul/${file} 出现禁止的 IO 依赖：${re}`)
    }
  }
})
