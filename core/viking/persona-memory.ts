// 按人设隔离的私有记忆存储（L2）。复用 Viking 的同一个 SQLite 连接，
// 保证 :memory: 场景下共享同一数据库。persona_memories(persona_id, category, content, updated_at)。

import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { cosine, createEmbedder, type Embedder } from '../embed.ts'
import type { PersonaMemoryItem } from '../types.ts'

const PERSONA_SCHEMA = `
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

interface PersonaRow {
  id: string
  persona_id: string
  category: string
  content: string
  embedding: string
  updated_at: string
}

export class PersonaMemoryStore {
  private readonly db: DatabaseSync
  private readonly embedder: Embedder

  constructor(db: DatabaseSync, embedder: Embedder = createEmbedder()) {
    this.db = db
    this.embedder = embedder
    this.db.exec(PERSONA_SCHEMA)
  }

  async remember(personaId: string, category: string, content: string): Promise<PersonaMemoryItem> {
    const clean = content.trim()
    if (!clean) throw new Error('soul_remember: content 不能为空')
    const id = randomUUID()
    const now = new Date().toISOString()
    const embedding = await this.embedder.embed(clean)
    this.db
      .prepare(
        'INSERT INTO persona_memories (id, persona_id, category, content, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, personaId, category, clean, JSON.stringify(embedding), now)
    return { id, uri: this.uri(personaId, id), personaId, category, content: clean, updatedAt: now }
  }

  async recall(personaId: string, query: string, topK = 5): Promise<PersonaMemoryItem[]> {
    const rows = this.db
      .prepare('SELECT * FROM persona_memories WHERE persona_id = ?')
      .all(personaId) as unknown as PersonaRow[]
    if (rows.length === 0) return []
    const queryEmbedding = await this.embedder.embed(query)
    const scored = rows
      .map((row) => {
        const vec = JSON.parse(row.embedding) as number[]
        return {
          row,
          // 跨向量空间（切换嵌入模型后）的旧条目按 -1 处理，排在末尾且不污染分数。
          score: vec.length === queryEmbedding.length ? cosine(queryEmbedding, vec) : -1,
        }
      })
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
    return scored.map(({ row }) => ({
      id: row.id,
      uri: this.uri(row.persona_id, row.id),
      personaId: row.persona_id,
      category: row.category,
      content: row.content,
      updatedAt: row.updated_at,
    }))
  }

  list(personaId: string): PersonaMemoryItem[] {
    const rows = this.db
      .prepare('SELECT * FROM persona_memories WHERE persona_id = ? ORDER BY updated_at DESC')
      .all(personaId) as unknown as PersonaRow[]
    return rows.map((row) => ({
      id: row.id,
      uri: this.uri(row.persona_id, row.id),
      personaId: row.persona_id,
      category: row.category,
      content: row.content,
      updatedAt: row.updated_at,
    }))
  }

  private uri(personaId: string, id: string): string {
    return `viking://souls/${personaId}/memory/${id}`
  }
}
