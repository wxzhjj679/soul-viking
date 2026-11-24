// 共性问题回流：验证失败/回退案例异步提取为 lint 规则、Skill 更新或 Soul 约束建议，
// 反馈到代码库本身，而非仅记录日志。

import type { VerificationReport } from './verifier.ts'

export interface FeedbackBundle {
  lintRules: string[]
  skillUpdates: string[]
  soulConstraints: string[]
}

const RULES: Array<{ re: RegExp; lint?: string; skill?: string; soul?: string }> = [
  {
    re: /TypeError|Cannot read|undefined is not|undefined 的属性/i,
    lint: '启用 strictNullChecks / noUncheckedIndexedAccess，禁止未校验的空值访问',
  },
  {
    re: /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed/i,
    skill: '外部服务调用前增加健康检查与重试/超时策略',
    soul: '涉及网络的子 Agent 必须声明超时与失败降级路径',
  },
  {
    re: /timeout|超时/i,
    soul: '长任务需显式设置超时并在超时后回退',
  },
  {
    re: /assert|AssertionError|expected .* to/i,
    skill: '为受影响能力补充/更新回归测试用例',
  },
  {
    re: /lint|eslint|prettier|format/i,
    lint: '将本次格式/lint 问题固化为 lint 规则',
  },
]

export function extractFeedback(report: VerificationReport): FeedbackBundle {
  const bundle: FeedbackBundle = { lintRules: [], skillUpdates: [], soulConstraints: [] }
  if (report.passed && report.failures.length === 0) return bundle

  const haystack = `${report.failures.map((f) => `${f.reason} ${f.detail ?? ''}`).join('\n')}\n${report.evidence
    .filter((e) => e.kind === 'stderr' || e.kind === 'stdout')
    .map((e) => e.detail)
    .join('\n')}`

  const push = (arr: string[], value?: string): void => {
    if (value && !arr.includes(value)) arr.push(value)
  }
  for (const rule of RULES) {
    if (rule.re.test(haystack)) {
      push(bundle.lintRules, rule.lint)
      push(bundle.skillUpdates, rule.skill)
      push(bundle.soulConstraints, rule.soul)
    }
  }
  return bundle
}
