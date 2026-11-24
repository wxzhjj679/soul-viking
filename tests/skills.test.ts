import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSkillRegistry, loadSkillRegistry, type SkillMeta } from '../core/skills/registry.ts'
import { classifyIntent, SkillRouter } from '../core/skills/router.ts'
import { SoulViking } from '../core/facade.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = loadSkillRegistry(join(ROOT, 'skills', 'registry.json'))

function meta(name: string, description: string, aliases: string[] = []): SkillMeta {
  return {
    name,
    aliases,
    description,
    input_schema: {},
    output_schema: {},
    requires_verification: false,
  }
}

test('技能注册表加载 >=3 个技能', () => {
  assert.ok(registry.list().length >= 3)
})

test('意图分类：纯对话 vs 执行', () => {
  assert.equal(classifyIntent('你好呀，今天心情不错').category, 'dialogue')
  assert.equal(classifyIntent('帮我生成一张海报').category, 'execute')
  assert.equal(classifyIntent('你好，帮我剪辑一个视频').category, 'route')
})

test('显式 Skill 名称优先（英文名）', async () => {
  const router = new SkillRouter(registry)
  const res = await router.route('用 video-editor 处理这个片段')
  assert.equal(res.mode, 'explicit')
  if (res.mode === 'explicit') assert.equal(res.skill.name, 'video-editor')
})

test('显式 Skill 中文别名优先', async () => {
  const router = new SkillRouter(registry)
  const res = await router.route('用剪映把这段处理一下')
  assert.equal(res.mode, 'explicit')
  if (res.mode === 'explicit') assert.equal(res.skill.name, 'video-editor')
})

test('纯对话不触发技能', async () => {
  const router = new SkillRouter(registry)
  const res = await router.route('你好呀，今天心情不错')
  assert.equal(res.mode, 'dialogue')
})

test('语义匹配：视频剪辑意图 Top1 为 video-editor', async () => {
  const router = new SkillRouter(registry, { threshold: 0.15 })
  const res = await router.route('生成视频，自动加字幕和转场，裁剪并拼接片段')
  assert.ok(res.candidates.length > 0)
  assert.equal(res.candidates[0]?.name, 'video-editor')
})

test('阈值门禁：无匹配时返回澄清问题', async () => {
  const router = new SkillRouter(registry)
  const res = await router.route('运行一下那个东西')
  assert.ok('question' in res || res.mode === 'dialogue')
})

test('有序多技能链：先…再…', async () => {
  const reg = createSkillRegistry([meta('alpha', '生成视频字幕转场'), meta('beta', '生成数据分析图表结论')])
  const router = new SkillRouter(reg, { threshold: 0.15 })
  const res = await router.route('先生成视频字幕，再生成数据分析图表')
  assert.equal(res.mode, 'chain')
  if (res.mode === 'chain') assert.deepEqual(res.chain.map((s) => s.name), ['alpha', 'beta'])
})

test('歧义门禁：Top1-Top2 过近时让用户选择', async () => {
  const reg = createSkillRegistry([meta('alpha', '生成视频字幕转场'), meta('beta', '生成视频字幕转场')])
  const router = new SkillRouter(reg, { threshold: 0.15 })
  const res = await router.route('生成视频字幕转场')
  assert.equal(res.mode, 'ambiguous')
  if (res.mode === 'ambiguous') assert.ok(res.question.length > 0)
})

test('技能注册表携带派发指引（外部能力目录）', () => {
  const video = registry.get('video-editor')
  assert.equal(video?.dispatch?.kind, 'external_mcp')
  assert.equal(video?.dispatch?.server, 'chatcut')
  assert.ok((video?.dispatch?.instructions ?? '').length > 0)
  const review = registry.get('code-reviewer')
  assert.equal(review?.dispatch?.kind, 'agent')
})

test('skill_execute 返回派发指引；handle 命中执行意图时直接带出 dispatch', async () => {
  const facade = new SoulViking({
    dbPath: ':memory:',
    soulsDir: join(ROOT, 'souls'),
    skillsRegistryPath: join(ROOT, 'skills', 'registry.json'),
  })
  try {
    const exec = facade.skillExecute('video-editor', { video_url: 'a.mp4' })
    assert.equal(exec.status, 'dispatched')
    assert.equal(exec.dispatch.kind, 'external_mcp')
    assert.equal(exec.dispatch.server, 'chatcut')
    assert.ok(exec.dispatch.command_hint?.includes('ffmpeg'))

    const handled = await facade.handle('用剪映帮我把这段素材剪一下')
    assert.equal(handled.intent, 'execute')
    assert.equal(handled.skill, 'video-editor')
    assert.equal(handled.dispatch?.server, 'chatcut')
  } finally {
    facade.close()
  }
})
