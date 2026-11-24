// 带 IO 的加载器：从磁盘读取 *.SOUL.md，解析为 L1 人格定义。
// 放在 core/soul 之外，保证 Soul 层源码不出现文件系统依赖。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parsePersona } from './soul/persona.ts'
import type { PersonaDef } from './types.ts'

export interface SoulMarkdown {
  file: string
  markdown: string
}

export function loadSoulMarkdownFiles(dir: string): SoulMarkdown[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith('.SOUL.md'))
    .sort()
    .map((file) => ({ file, markdown: readFileSync(join(dir, file), 'utf8') }))
}

export function loadPersonas(dir: string): PersonaDef[] {
  return loadSoulMarkdownFiles(dir).map(({ file, markdown }) =>
    parsePersona(markdown, file.replace(/\.SOUL\.md$/, '')),
  )
}
