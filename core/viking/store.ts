// Viking 记忆存储（L2）。SQLite（node:sqlite）保存结构化元数据 + 精确向量检索。
// - 写入时自动生成 L0/L1/L2 三层表示
// - 向量以 JSON 化 float 数组存储，检索用余弦精确近邻（可替换为 ANN 索引）
// - 冲突策略：最新事实优先 + 标记冲突（旧条目 superseded_by 指向新条目，不简单覆盖）

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { cosine, createEmbedder, type Embedder } from '../embed.ts'
import { buildLayers } from '../text.ts'
import { dirOf, isVikingUri, kindOf, normalizeUri } from '../uri.ts'

export interface StoredMemory {
  uri: string
  l0: string
  l1: string
  l2: string
  tokensL0: number
  tokensL1: number
  tags: string[]
  kind: string
  directory: string
  /** 记忆所有者（多用户隔离）。空串 = 全局记忆，对所有 owner 可见。 */
  owner: string
  createdAt: string
  updatedAt: string
  forgotten: boolean
  supersededBy: string | null
}

export interface StoreMemoryResult {
  uri: string
  layers: { l0: string; l1: string; l2: string }
  superseded: string[]
  conflict: boolean
}

export interface ScoredMemory {
  uri: string
  score: number
  memory: StoredMemory
}

export interface StoreOptions {
  dbPath?: string
  embedder?: Embedder
  conflictThreshold?: number
}

export const VIKING_SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (
  uri          TEXT PRIMARY KEY,
  l0           TEXT NOT NULL,
  l1           TEXT NOT NULL,
  l2           TEXT NOT NULL,
  tokens_l0    INTEGER NOT NULL,
  tokens_l1    INTEGER NOT NULL,
  tags         TEXT NOT NULL DEFAULT '[]',
  kind         TEXT NOT NULL DEFAULT 'memory',
  dir          TEXT NOT NULL,
  owner        TEXT NOT NULL DEFAULT '',
  embedding    TEXT NOT NULL,
  dim          INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  forgotten    INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_memories_dir ON memories(dir);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_owner ON memories(owner);
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(forgotten, superseded_by);

CREATE TABLE IF NOT EXISTS traces (
  id          TEXT PRIMARY KEY,
  query       TEXT NOT NULL,
  steps_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conflicts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uri_old     TEXT NOT NULL,
  uri_new     TEXT NOT NULL,
  similarity  REAL NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persona_memories (
  id          TEXT PRIMARY KEY,
  persona_id  TEXT NOT NULL,
  category    TEXT NOT NULL,
  content     TEXT NOT NULL,
  embedding   TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_persona_mem ON persona_memories(persona_id);
`

interface MemoryRow {
  uri: string
  l0: string
  l1: string
  l2: string
  tokens_l0: number
  tokens_l1: number
  tags: string
  kind: string
  dir: string
  owner: string
  embedding: string
  dim: number
  created_at: string
  updated_at: string
  forgotten: number
  superseded_by: string | null
}

function rowToMemory(row: MemoryRow): StoredMemory {
  let tags: string[] = []
  try {
    tags = JSON.parse(row.tags) as string[]
  } catch {
    tags = []
  }
  return {
    uri: row.uri,
    l0: row.l0,
    l1: row.l1,
    l2: row.l2,
    tokensL0: row.tokens_l0,
    tokensL1: row.tokens_l1,
    tags,
    kind: row.kind,
    directory: row.dir,
    owner: row.owner ?? '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    forgotten: row.forgotten === 1,
    supersededBy: row.superseded_by,
  }
}

export class VikingStore {
  readonly db: DatabaseSync
  readonly embedder: Embedder
  private readonly conflictThreshold: number
  private readonly now: () => string

  constructor(options: StoreOptions = {}) {
    const dbPath = options.dbPath ?? process.env.SOULVIKING_DB ?? ':memory:'
    if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.embedder = options.embedder ?? createEmbedder()
    this.conflictThreshold = options.conflictThreshold ?? 0.9
    this.now = () => new Date().toISOString()
    this.db.exec(VIKING_SCHEMA)
    // 旧库迁移：memories 缺 owner 列时补齐（默认空串 = 全局记忆，行为向后兼容）。
    const columns = this.db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>
    if (!columns.some((c) => c.name === 'owner')) {
      this.db.exec("ALTER TABLE memories ADD COLUMN owner TEXT NOT NULL DEFAULT ''")
    }
  }

  async storeMemory(text: string, uri?: string, tags: string[] = [], owner = ''): Promise<StoreMemoryResult> {
    const clean = text.trim()
    if (!clean) throw new Error('memory_store: text 不能为空')
    const finalUri = uri ? normalizeUri(uri) : `viking://memories/unfiled/${randomUUID()}`
    if (!isVikingUri(finalUri)) throw new Error(`memory_store: 非法 viking URI -> ${uri}`)
    const dir = dirOf(finalUri)
    const kind = kindOf(finalUri)
    const layers = buildLayers(clean)
    const embedding = await this.embedder.embed(clean)
    const embeddingJson = JSON.stringify(embedding)
    const now = this.now()

    // 冲突检测：同目录 + 同 owner 下相似度超阈值的活跃条目，标记为被新条目取代（不删除）。
    // owner 隔离：绝不跨所有者标记 superseded（否则等于篡改/遮蔽他人记忆）。
    const superseded: string[] = []
    const actives = this.db
      .prepare(
        'SELECT uri, embedding FROM memories WHERE dir = ? AND owner = ? AND forgotten = 0 AND superseded_by IS NULL AND uri <> ?',
      )
      .all(dir, owner, finalUri) as Array<{ uri: string; embedding: string }>
    for (const row of actives) {
      const rowVec = JSON.parse(row.embedding) as number[]
      // 跨向量空间（如刚切换嵌入模型）的旧条目不参与冲突判定，避免伪相似度误标取代。
      if (rowVec.length !== embedding.length) continue
      const similarity = cosine(embedding, rowVec)
      if (similarity >= this.conflictThreshold) {
        this.db
          .prepare('UPDATE memories SET superseded_by = ?, updated_at = ? WHERE uri = ?')
          .run(finalUri, now, row.uri)
        this.db
          .prepare('INSERT INTO conflicts (uri_old, uri_new, similarity, created_at) VALUES (?, ?, ?, ?)')
          .run(row.uri, finalUri, similarity, now)
        superseded.push(row.uri)
      }
    }

    this.db
      .prepare(
        `INSERT INTO memories
          (uri, l0, l1, l2, tokens_l0, tokens_l1, tags, kind, dir, owner, embedding, dim, created_at, updated_at, forgotten, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
         ON CONFLICT(uri) DO UPDATE SET
           l0 = excluded.l0, l1 = excluded.l1, l2 = excluded.l2,
           tokens_l0 = excluded.tokens_l0, tokens_l1 = excluded.tokens_l1,
           tags = excluded.tags, kind = excluded.kind, dir = excluded.dir,
           embedding = excluded.embedding, dim = excluded.dim,
           updated_at = excluded.updated_at, forgotten = 0`,
      )
      .run(
        finalUri,
        layers.l0,
        layers.l1,
        layers.l2,
        layers.tokensL0,
        layers.tokensL1,
        JSON.stringify(tags),
        kind,
        dir,
        owner,
        embeddingJson,
        embedding.length,
        now,
        now,
      )

    return {
      uri: finalUri,
      layers: { l0: layers.l0, l1: layers.l1, l2: layers.l2 },
      superseded,
      conflict: superseded.length > 0,
    }
  }

  get(uri: string): StoredMemory | null {
    if (!isVikingUri(uri)) return null
    const row = this.db.prepare('SELECT * FROM memories WHERE uri = ?').get(normalizeUri(uri)) as
      | MemoryRow
      | undefined
    return row ? rowToMemory(row) : null
  }

  /** owner 可见性过滤：传入 owner 时仅返回「该 owner 私有 + 全局（owner='')」的记忆。 */
  private static readonly ACTIVE_BASE = 'SELECT * FROM memories WHERE forgotten = 0 AND superseded_by IS NULL'
  private static readonly OWNER_FILTER = " AND (owner = ? OR owner = '')"

  listActive(limit = 1000, owner?: string): StoredMemory[] {
    const rows = (
      owner === undefined
        ? this.db
            .prepare(`${VikingStore.ACTIVE_BASE} ORDER BY updated_at DESC LIMIT ?`)
            .all(limit)
        : this.db
            .prepare(`${VikingStore.ACTIVE_BASE}${VikingStore.OWNER_FILTER} ORDER BY updated_at DESC LIMIT ?`)
            .all(owner, limit)
    ) as unknown as MemoryRow[]
    return rows.map(rowToMemory)
  }

  /** 精确向量近邻检索（仅活跃、未被取代的条目；传 owner 时按可见性过滤）。 */
  async search(query: string, limit = 10, owner?: string): Promise<ScoredMemory[]> {
    const rows = (
      owner === undefined
        ? this.db.prepare(VikingStore.ACTIVE_BASE).all()
        : this.db.prepare(`${VikingStore.ACTIVE_BASE}${VikingStore.OWNER_FILTER}`).all(owner)
    ) as unknown as MemoryRow[]
    const queryEmbedding = await this.embedder.embed(query)
    const scored: ScoredMemory[] = []
    for (const row of rows) {
      // 向量空间防护：切换嵌入模型后旧向量维度不同，直接跳过（不产出跨空间的伪分数）。
      // 用 scripts/reembed.ts 对旧库重嵌入后即可恢复召回。
      if (row.dim !== queryEmbedding.length) continue
      const similarity = cosine(queryEmbedding, JSON.parse(row.embedding) as number[])
      if (similarity > 0) scored.push({ uri: row.uri, score: similarity, memory: rowToMemory(row) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  /** 遗忘：URI 直接标记；否则按查询匹配相似条目标记（不物理删除）。传 owner 时只能遗忘自己的记忆。 */
  async forget(uriOrQuery: string, owner?: string): Promise<{ forgotten: string[] }> {
    const now = this.now()
    if (isVikingUri(uriOrQuery)) {
      const uri = normalizeUri(uriOrQuery)
      const res =
        owner === undefined
          ? this.db
              .prepare('UPDATE memories SET forgotten = 1, updated_at = ? WHERE uri = ? AND forgotten = 0')
              .run(now, uri)
          : this.db
              .prepare("UPDATE memories SET forgotten = 1, updated_at = ? WHERE uri = ? AND forgotten = 0 AND owner = ?")
              .run(now, uri, owner)
      return { forgotten: Number(res.changes) > 0 ? [uri] : [] }
    }
    const hits = (await this.search(uriOrQuery, 50, owner)).filter((s) => s.score >= 0.35)
    const forgotten: string[] = []
    const stmt =
      owner === undefined
        ? this.db.prepare('UPDATE memories SET forgotten = 1, updated_at = ? WHERE uri = ?')
        : this.db.prepare('UPDATE memories SET forgotten = 1, updated_at = ? WHERE uri = ? AND owner = ?')
    for (const hit of hits) {
      if (owner === undefined) stmt.run(now, hit.uri)
      else stmt.run(now, hit.uri, owner)
      forgotten.push(hit.uri)
    }
    return { forgotten }
  }

  saveTrace(id: string, query: string, steps: unknown[], createdAt: string): void {
    this.db
      .prepare('INSERT OR REPLACE INTO traces (id, query, steps_json, created_at) VALUES (?, ?, ?, ?)')
      .run(id, query, JSON.stringify(steps), createdAt)
  }

  listTraces(limit = 20): Array<{ id: string; query: string; steps: unknown[]; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT * FROM traces ORDER BY created_at DESC LIMIT ?')
      .all(limit) as Array<{ id: string; query: string; steps_json: string; created_at: string }>
    return rows.map((r) => ({
      id: r.id,
      query: r.query,
      steps: JSON.parse(r.steps_json) as unknown[],
      createdAt: r.created_at,
    }))
  }

  listConflicts(): Array<{ uriOld: string; uriNew: string; similarity: number; createdAt: string }> {
    const rows = this.db
      .prepare('SELECT * FROM conflicts ORDER BY created_at DESC')
      .all() as Array<{ uri_old: string; uri_new: string; similarity: number; created_at: string }>
    return rows.map((r) => ({
      uriOld: r.uri_old,
      uriNew: r.uri_new,
      similarity: r.similarity,
      createdAt: r.created_at,
    }))
  }

  countActive(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM memories WHERE forgotten = 0 AND superseded_by IS NULL')
      .get() as { n: number }
    return row.n
  }

  close(): void {
    this.db.close()
  }
}
