// 验证 Agent 与测试运行器的集成：以 node 内置 test runner 作为默认验证执行器，
// 在目标目录运行测试并采集可审计证据（退出码 / 输出 / 耗时）。

import { VerificationService, type VerificationReport, type VerifyTask } from '../core/verify/verifier.ts'

export interface TestRunnerOptions {
  taskId?: string
  command?: string
  args?: string[]
  timeoutMs?: number
}

export function buildTestRunnerTask(taskId: string, targetDir: string, options: TestRunnerOptions = {}): VerifyTask {
  const task: VerifyTask = {
    taskId,
    targetDir,
    command: options.command ?? process.execPath,
    args: options.args ?? ['--test', '--no-warnings'],
    timeoutMs: options.timeoutMs ?? 120_000,
  }
  return task
}

/** 运行目标目录的测试套件，返回附带证据的验证报告。 */
export async function runTestSuite(
  service: VerificationService,
  targetDir: string,
  options: TestRunnerOptions = {},
): Promise<VerificationReport> {
  const taskId = options.taskId ?? `test-suite-${Date.now()}`
  service.registerTask(buildTestRunnerTask(taskId, targetDir, options))
  return service.run(taskId)
}
