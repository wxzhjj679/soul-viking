// 目录递归检索 + L0/L1 分层注入（OpenViking 范式）。
// 1) 先按向量得分聚合到「目录」，定位最高分目录；
// 2) 在该目录内下钻取 topK 记忆，并附带同目录邻居上下文；
// 3) 注入时 Top-3 用 L1 概览（~300 tokens），其余用 L0 摘要（~50 tokens）；
// 4) 全过程记录 directory-browsing trajectory 落到 viking://traces。

import { randomUUID } from 'node:crypto'
import { dirOf } from '../uri.ts'
import type { MemoryChunk, RetrievalTrace } from '../types.ts'
import type { ScoredMemory, VikingStore } from './store.ts'

export type { MemoryChunk, MemoryLayer, RetrievalTrace, TraceStep } from '../types.ts'

export interface RecallResult {
  chunks: MemoryChunk[]
  trace: RetrievalTrace
  topDirectory: string | null
  injectedL1: number
  injectedL0: number
}

export interface RecallOptions {
  recordTrace?: boolean
  topK?: number
  layerTopN?: number
  /** 记忆所有者：传入后仅召回「该 owner 私有 + 全局」记忆（多用户隔离）。 */
  owner?: string
}

/** 构造邻居上下文：同目录其它记忆的 L0 摘要拼接（最多 3 条；遵循 owner 可见性）。 */
function buildNeighborContext(store: VikingStore, uri: string, directory: string, owner?: string): string {
  const siblings = store
    .listActive(1000, owner)
    .filter((m) => m.directory === directory && m.uri !== uri)
    .slice(0, 3)
    .map((m) => m.l0)
  return siblings.join(' ｜ ')
}

export async function directoryRecursiveRecall(
  store: VikingStore,
  query: string,
  options: RecallOptions = {},
): Promise<RecallResult> {
  const topK = options.topK ?? 10
  const layerTopN = options.layerTopN ?? 3
  const recordTrace = options.recordTrace ?? true
  const all = await store.search(query, 10000, options.owner)

  if (all.length === 0) {
    const trace: RetrievalTrace = {
      id: randomUUID(),
      query,
      steps: [{ phase: 'empty', detail: { reason: 'no-active-memory' } }],
    }
    if (recordTrace) store.saveTrace(trace.id, query, trace.steps, new Date().toISOString())
    return { chunks: [], trace, topDirectory: null, injectedL1: 0, injectedL0: 0 }
  }

  // 阶段 1：按目录聚合向量得分，定位最高分目录。
  const directoryScores = new Map<string, { max: number; sum: number; count: number; uris: string[] }>()
  for (const hit of all) {
    const directory = dirOf(hit.uri)
    const entry = directoryScores.get(directory) ?? { max: 0, sum: 0, count: 0, uris: [] }
    entry.max = Math.max(entry.max, hit.score)
    entry.sum += hit.score
    entry.count += 1
    entry.uris.push(hit.uri)
    directoryScores.set(directory, entry)
  }
  const rankedDirs = [...directoryScores.entries()].sort((a, b) => b[1].max - a[1].max)
  const topDirectory = rankedDirs[0]?.[0] ?? null

  // 阶段 2：在最高分目录内下钻，不足 topK 时用全局次优补足。
  const inDir: ScoredMemory[] = topDirectory
    ? all.filter((hit) => dirOf(hit.uri) === topDirectory)
    : []
  const selected: ScoredMemory[] = [...inDir.slice(0, topK)]
  if (selected.length < topK) {
    const chosen = new Set(selected.map((s) => s.uri))
    for (const hit of all) {
      if (selected.length >= topK) break
      if (!chosen.has(hit.uri)) {
        selected.push(hit)
        chosen.add(hit.uri)
      }
    }
  }

  // 阶段 3：分层注入。
  const chunks: MemoryChunk[] = selected.map((hit, index) => {
    const memory = hit.memory
    const useL1 = index < layerTopN
    return {
      uri: hit.uri,
      layer: useL1 ? 'L1' : 'L0',
      text: useL1 ? memory.l1 : memory.l0,
      score: hit.score,
      directory: memory.directory,
      neighborContext: buildNeighborContext(store, hit.uri, memory.directory, options.owner),
    }
  })

  const injectedL1 = chunks.filter((c) => c.layer === 'L1').length
  const injectedL0 = chunks.filter((c) => c.layer === 'L0').length

  const trace: RetrievalTrace = {
    id: randomUUID(),
    query,
    steps: [
      {
        phase: 'directory-scan',
        detail: {
          topDirectory,
          candidates: rankedDirs
            .slice(0, 5)
            .map(([dir, info]) => ({ dir, maxScore: Number(info.max.toFixed(4)) })),
        },
      },
      {
        phase: 'drill-down',
        detail: { directory: topDirectory, selected: selected.map((s) => s.uri) },
      },
      {
        phase: 'layer-inject',
        detail: {
          layerTopN,
          injectedL1: chunks.filter((c) => c.layer === 'L1').map((c) => c.uri),
          injectedL0: chunks.filter((c) => c.layer === 'L0').map((c) => c.uri),
        },
      },
    ],
  }
  if (recordTrace) store.saveTrace(trace.id, query, trace.steps, new Date().toISOString())

  return { chunks, trace, topDirectory, injectedL1, injectedL0 }
}
