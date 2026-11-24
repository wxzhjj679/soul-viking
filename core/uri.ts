// viking:// URI 工具。所有上下文（记忆/资源/Skill）统一映射到该命名空间。

const PREFIX = 'viking://'

export function isVikingUri(value: string): boolean {
  return value.startsWith(PREFIX) && value.length > PREFIX.length
}

export function normalizeUri(uri: string): string {
  let u = uri.trim()
  if (!u.startsWith(PREFIX)) u = PREFIX + u.replace(/^\/+/, '')
  u = u.replace(/\/{2,}/g, '/')
  // 保留协议头的双斜杠
  u = u.replace('viking:/', 'viking://')
  if (u.length > PREFIX.length && u.endsWith('/')) u = u.slice(0, -1)
  return u
}

export function componentsOf(uri: string): string[] {
  return normalizeUri(uri).slice(PREFIX.length).split('/').filter(Boolean)
}

/** 目录 = URI 去掉最后一段；根目录返回 'viking://'。 */
export function dirOf(uri: string): string {
  const u = normalizeUri(uri)
  const idx = u.lastIndexOf('/')
  if (idx <= PREFIX.length - 1) return PREFIX
  return u.slice(0, idx)
}

/** 类型标签：取前两段（如 memories/user、resources/skills）。 */
export function kindOf(uri: string): string {
  const parts = componentsOf(uri)
  return parts.slice(0, 2).join('/') || 'memory'
}

export function isWithin(uri: string, directory: string): boolean {
  const u = normalizeUri(uri)
  const d = normalizeUri(directory)
  return u === d || u.startsWith(`${d}/`)
}
