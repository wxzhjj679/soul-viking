// 自动合并门禁：仅当验证通过且证据非空、且历史失败率不超过阈值时允许 auto_merge。

import type { VerificationReport } from './verifier.ts'

export interface FailureStats {
  attempts: number
  failures: number
}

export interface MergeGateConfig {
  maxFailureRate?: number
  requireEvidence?: boolean
}

export interface MergeDecision {
  allowed: boolean
  reasons: string[]
  failureRate: number
}

export function failureRate(stats: FailureStats): number {
  if (stats.attempts <= 0) return 0
  return stats.failures / stats.attempts
}

export function autoMergeAllowed(
  report: VerificationReport,
  stats: FailureStats = { attempts: 0, failures: 0 },
  config: MergeGateConfig = {},
): MergeDecision {
  const maxFailureRate = config.maxFailureRate ?? 0.005
  const requireEvidence = config.requireEvidence ?? true
  const rate = failureRate(stats)
  const reasons: string[] = []

  if (!report.passed) reasons.push('验证未通过')
  if (requireEvidence && report.evidence.length === 0) reasons.push('缺少可审计证据')
  if (rate > maxFailureRate) {
    reasons.push(`历史失败率 ${(rate * 100).toFixed(2)}% 超过阈值 ${(maxFailureRate * 100).toFixed(2)}%`)
  }

  return { allowed: reasons.length === 0, reasons, failureRate: rate }
}
