-- SOUL-Viking 记忆库 schema（SQLite）。与 core/viking/store.ts 的 VIKING_SCHEMA 保持一致。
-- 初始化：node viking/init.ts <dbPath>

CREATE TABLE IF NOT EXISTS memories (
  uri           TEXT PRIMARY KEY,        -- viking:// 命名空间
  l0            TEXT NOT NULL,           -- ≤50 tokens 摘要
  l1            TEXT NOT NULL,           -- ≤300 tokens 概览
  l2            TEXT NOT NULL,           -- 完整原文
  tokens_l0     INTEGER NOT NULL,
  tokens_l1     INTEGER NOT NULL,
  tags          TEXT NOT NULL DEFAULT '[]',
  kind          TEXT NOT NULL DEFAULT 'memory',  -- 如 memories/user, resources/skills
  dir           TEXT NOT NULL,           -- 所属目录（用于递归检索聚合）
  embedding     TEXT NOT NULL,           -- JSON 化向量（精确近邻，可替换 ANN）
  dim           INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  forgotten     INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT                     -- 冲突：被更新的同主题记忆取代
);
CREATE INDEX IF NOT EXISTS idx_memories_dir ON memories(dir);
CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(forgotten, superseded_by);

CREATE TABLE IF NOT EXISTS traces (
  id          TEXT PRIMARY KEY,
  query       TEXT NOT NULL,
  steps_json  TEXT NOT NULL,             -- directory-browsing trajectory
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conflicts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  uri_old     TEXT NOT NULL,
  uri_new     TEXT NOT NULL,
  similarity  REAL NOT NULL,
  created_at  TEXT NOT NULL
);

-- 人设私有记忆（按 persona 隔离）
CREATE TABLE IF NOT EXISTS persona_memories (
  id          TEXT PRIMARY KEY,
  persona_id  TEXT NOT NULL,
  category    TEXT NOT NULL,
  content     TEXT NOT NULL,
  embedding   TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_persona_mem ON persona_memories(persona_id);
