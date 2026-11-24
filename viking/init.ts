// Viking 存储初始化脚本。
// 用法：node viking/init.ts <dbPath>   (默认 viking.db)

import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VIKING_SCHEMA } from '../core/viking/store.ts'

export function initVikingDb(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  db.exec(VIKING_SCHEMA)
  return db
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false
if (isMain) {
  const target = process.argv[2] ?? 'viking.db'
  const db = initVikingDb(target)
  db.close()
  console.error(`viking db 初始化完成：${target}`)
}
