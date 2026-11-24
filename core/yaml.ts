// 极简 YAML 子集解析器 + Markdown frontmatter 解析。
// 仅覆盖本项目 Soul / Agent Soul 文件所需的子集：顶层标量、标量列表、
// 以及「对象列表」（如 slash_commands: [{name, description}]）。
// 不引入外部 yaml 依赖，保持零运行时依赖。

interface YLine {
  indent: number
  text: string
}

function lex(src: string): YLine[] {
  const out: YLine[] = []
  for (const raw of src.split(/\r?\n/)) {
    const withoutTrailing = raw.replace(/\s+$/, '')
    const trimmed = withoutTrailing.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) continue
    const indent = withoutTrailing.length - withoutTrailing.trimStart().length
    out.push({ indent, text: trimmed })
  }
  return out
}

function coerce(value: string): unknown {
  const v = value.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  if (v === '[]') return []
  if (v === '{}') return {}
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~') return null
  if (/^-?\d+$/.test(v)) return Number(v)
  if (/^-?\d+\.\d+$/.test(v)) return Number(v)
  if ((v.startsWith('[') && v.endsWith(']')) || (v.startsWith('{') && v.endsWith('}'))) {
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  }
  return v
}

const KV_RE = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/

function parseMap(lines: YLine[], start: number, indent: number): [Record<string, unknown>, number] {
  const obj: Record<string, unknown> = {}
  let i = start
  while (i < lines.length) {
    const line = lines[i] as YLine
    if (line.indent !== indent || line.text.startsWith('- ')) break
    const m = line.text.match(KV_RE)
    if (!m) {
      i += 1
      continue
    }
    const key = m[1] as string
    const rest = m[2]
    if (rest !== undefined && rest.trim() !== '') {
      obj[key] = coerce(rest)
      i += 1
    } else if (i + 1 < lines.length && (lines[i + 1] as YLine).indent > indent) {
      const [val, next] = parseBlock(lines, i + 1, (lines[i + 1] as YLine).indent)
      obj[key] = val
      i = next
    } else {
      obj[key] = null
      i += 1
    }
  }
  return [obj, i]
}

function parseSeq(lines: YLine[], start: number, indent: number): [unknown[], number] {
  const arr: unknown[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i] as YLine
    if (line.indent !== indent || !line.text.startsWith('- ')) break
    const itemText = line.text.slice(2).trim()
    const m = itemText.match(KV_RE)
    if (m) {
      const obj: Record<string, unknown> = {}
      const key = m[1] as string
      const rest = m[2]
      obj[key] = rest !== undefined && rest.trim() !== '' ? coerce(rest) : null
      i += 1
      if (i < lines.length && (lines[i] as YLine).indent > indent && !(lines[i] as YLine).text.startsWith('- ')) {
        const [more, next] = parseMap(lines, i, (lines[i] as YLine).indent)
        Object.assign(obj, more)
        i = next
      }
      arr.push(obj)
    } else {
      arr.push(coerce(itemText))
      i += 1
    }
  }
  return [arr, i]
}

function parseBlock(lines: YLine[], start: number, indent: number): [unknown, number] {
  if (start >= lines.length) return [null, start]
  const first = lines[start] as YLine
  if (first.indent < indent) return [null, start]
  return first.text.startsWith('- ')
    ? parseSeq(lines, start, first.indent)
    : parseMap(lines, start, first.indent)
}

export function parseYamlSubset(src: string): Record<string, unknown> {
  const lines = lex(src)
  if (lines.length === 0) return {}
  const [value] = parseBlock(lines, 0, (lines[0] as YLine).indent)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

export interface Frontmatter {
  data: Record<string, unknown>
  body: string
}

/** 解析 `--- ... ---` frontmatter；无 frontmatter 时 data 为空、body 为全文。 */
export function parseFrontmatter(markdown: string): Frontmatter {
  const norm = markdown.replace(/^﻿/, '')
  if (norm.startsWith('---')) {
    const m = norm.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/)
    if (m) {
      return { data: parseYamlSubset(m[1] ?? ''), body: norm.slice(m[0].length).trim() }
    }
  }
  return { data: {}, body: norm.trim() }
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string' && value.trim()) return [value]
  return []
}
