// 旧库重嵌入迁移脚本。
//
// 何时需要：切换嵌入模型后（如从默认 hashing 切到 bge-m3，或在两个真实模型之间切换），
// 库里旧向量与新向量空间不兼容——检索会自动跳过维度不符的旧条目（表现为"记忆失忆"）。
// 本脚本用当前配置的 embedder 对全部记忆重算向量，跑完即恢复召回。
//
// 用法（先停掉 MCP 服务，避免并发写库）：
//   node scripts/reembed.ts [dbPath]
//   # dbPath 缺省读 SOULVIKING_DB，再缺省 <repo>/data/viking.db
//   # 远程嵌入需同时设置 SOULVIKING_EMBED_URL / SOULVIKING_EMBED_MODEL（与服务端一致！）
//
// 行为：重嵌入 memories（含已遗忘/被取代条目，保持全库向量空间一致）与 persona_memories；
// 只更新 embedding/dim 两列，不触碰内容与时间戳。

import { DatabaseSync } from 'node:sqlite'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEmbedder } from '../core/embed.ts'

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHUNK = 32

async function main(): Promise<void> {
  const dbPath = process.argv[2] ?? process.env.SOULVIKING_DB ?? resolve(PROJECT_ROOT, 'data', 'viking.db')
  const db = new DatabaseSync(dbPath)
  const embedder = createEmbedder()

  let memoriesUpdated = 0
  let personaUpdated = 0

  const memories = db.prepare('SELECT uri, l2 FROM memories').all() as Array<{ uri: string; l2: string }>
  for (let i = 0; i < memories.length; i += CHUNK) {
    const chunk = memories.slice(i, i + CHUNK)
    // l2 即入库时的原文（buildLayers 保证），用它重算向量与原实现语义一致。
    const vectors = await embedder.embedBatch(chunk.map((row) => row.l2))
    const update = db.prepare('UPDATE memories SET embedding = ?, dim = ? WHERE uri = ?')
    chunk.forEach((row, j) => {
      update.run(JSON.stringify(vectors[j]), vectors[j].length, row.uri)
      memoriesUpdated += 1
    })
  }

  const personas = db.prepare('SELECT id, content FROM persona_memories').all() as Array<{ id: string; content: string }>
  for (let i = 0; i < personas.length; i += CHUNK) {
    const chunk = personas.slice(i, i + CHUNK)
    const vectors = await embedder.embedBatch(chunk.map((row) => row.content))
    const update = db.prepare('UPDATE persona_memories SET embedding = ? WHERE id = ?')
    chunk.forEach((row, j) => {
      update.run(JSON.stringify(vectors[j]), row.id)
      personaUpdated += 1
    })
  }

  db.close()
  console.error(
    `[reembed] 完成：memories=${memoriesUpdated} persona_memories=${personaUpdated} · embedder=${embedder.constructor.name} dim=${embedder.dim}`,
  )
}

main().catch((error) => {
  console.error(`[reembed] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
