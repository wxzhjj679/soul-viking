// 人格解析与三种提示词注入模式。纯函数，无任何 IO 依赖（满足 Soul 层隔离约束）。
// 注入时始终保留工具 schema 与运行时上下文，只替换/移动人格正文。

import { asString, parseFrontmatter } from '../yaml.ts'
import type { InjectionMode, PersonaDef, SystemPromptParts } from '../types.ts'

const MODES: InjectionMode[] = ['prefer', 'replace', 'append']

export function parsePersona(markdown: string, fallbackId?: string): PersonaDef {
  const { data, body } = parseFrontmatter(markdown)
  const id = asString(data.id, fallbackId ?? 'unnamed')
  const name = asString(data.name, id)
  const description = asString(data.description, '')
  const rawMode = asString(data.injection, asString(data.inject, 'prefer'))
  const injectionDefault: InjectionMode = (MODES as string[]).includes(rawMode)
    ? (rawMode as InjectionMode)
    : 'prefer'
  const model = typeof data.model === 'string' ? data.model : undefined
  return {
    id,
    name,
    description,
    body: body || description || name,
    injectionDefault,
    ...(model ? { model } : {}),
  }
}

export function normalizeMode(mode?: string): InjectionMode {
  return mode && (MODES as string[]).includes(mode) ? (mode as InjectionMode) : 'prefer'
}

/**
 * 组装系统提示词：
 * - prefer：人格正文置于最前（优先），后接基础指令 / 工具 schema / 运行时上下文；
 * - replace：人格正文替换基础指令正文，但工具 schema 与运行时上下文仍保留；
 * - append：基础指令之后、工具 schema 之前追加人格正文（末尾段落）。
 */
export function injectPersona(
  personaBody: string,
  parts: SystemPromptParts,
  mode: InjectionMode = 'prefer',
): string {
  const persona = (personaBody ?? '').trim()
  const base = (parts.baseInstructions ?? '').trim()
  const tools = (parts.toolSchema ?? '').trim()
  const runtime = (parts.runtimeContext ?? '').trim()
  const join = (segments: Array<string | undefined>): string =>
    segments.filter((s): s is string => Boolean(s && s.trim())).join('\n\n')

  switch (mode) {
    case 'replace':
      return join([persona, tools, runtime])
    case 'append':
      return join([base, tools, persona, runtime])
    case 'prefer':
    default:
      return join([persona, base, tools, runtime])
  }
}

export function personaById(personas: PersonaDef[], id: string): PersonaDef | undefined {
  return personas.find((p) => p.id === id)
}
