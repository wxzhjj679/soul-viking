import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { autoMergeAllowed } from '../core/verify/gate.ts'
import { extractFeedback } from '../core/verify/feedback.ts'
import { VerificationService, VerifyPolicyError } from '../core/verify/verifier.ts'
import { runTestSuite } from '../verify/runner.ts'

// 测试统一策略：允许在系统临时目录下执行（生产默认收敛到服务进程 cwd）。
const TEST_POLICY = { allowedRoots: [tmpdir()] }

test('验证通过：采集证据且 passed=true', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sv-pass-'))
  try {
    const service = new VerificationService(TEST_POLICY)
    service.registerTask({ taskId: 'pass', targetDir: dir, command: process.execPath, args: ['-e', 'process.exit(0)'] })
    const report = await service.run('pass')
    assert.equal(report.passed, true)
    assert.equal(report.exitCode, 0)
    assert.ok(report.evidence.length >= 3)
    assert.ok(report.evidence.some((e) => e.kind === 'exit'))
    assert.ok(service.evidence('pass').length >= 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('验证失败：非零退出码并记录失败原因与 stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sv-fail-'))
  try {
    const service = new VerificationService(TEST_POLICY)
    service.registerTask({
      taskId: 'fail',
      targetDir: dir,
      command: process.execPath,
      args: ['-e', 'console.error("TypeError: boom"); process.exit(1)'],
    })
    const report = await service.run('fail')
    assert.equal(report.passed, false)
    assert.notEqual(report.exitCode, 0)
    assert.ok(report.failures.length > 0)
    assert.ok(report.evidence.some((e) => e.kind === 'stderr'))

    // 共性问题回流
    const feedback = extractFeedback(report)
    assert.ok(feedback.lintRules.some((r) => r.includes('strictNullChecks')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('执行超时被终止且判为失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sv-timeout-'))
  try {
    const service = new VerificationService(TEST_POLICY)
    service.registerTask({
      taskId: 'slow',
      targetDir: dir,
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 5000)'],
      timeoutMs: 250,
    })
    const report = await service.run('slow')
    assert.equal(report.passed, false)
    assert.ok(report.evidence.some((e) => e.kind === 'timeout'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('命令无法启动：spawn_error 证据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sv-spawn-'))
  try {
    // 白名单显式放行该（不存在的）命令，验证 spawn 失败时仍能产出 spawn_error 证据。
    const service = new VerificationService({
      allowedRoots: [tmpdir()],
      allowedCommands: ['definitely-not-a-real-cmd-xyz'],
    })
    service.registerTask({ taskId: 'nope', targetDir: dir, command: 'definitely-not-a-real-cmd-xyz' })
    const report = await service.run('nope')
    assert.equal(report.passed, false)
    assert.ok(report.evidence.some((e) => e.kind === 'spawn_error'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('安全策略：白名单外命令 / 越界目录 / 带路径命令在注册期即被拒绝', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sv-policy-'))
  try {
    const service = new VerificationService(TEST_POLICY)
    // 1. 白名单外命令（典型 RCE payload）直接抛 VerifyPolicyError
    assert.throws(
      () => service.registerTask({ taskId: 'evil', targetDir: dir, command: 'rm', args: ['-rf', '/'] }),
      VerifyPolicyError,
    )
    // 2. target_dir 越界（../ 逃逸出允许根目录）被拒绝
    assert.throws(
      () => service.registerTask({ taskId: 'esc', targetDir: join(dir, '../../etc'), command: 'node' }),
      VerifyPolicyError,
    )
    // 3. 带路径命令：白名单内的可执行名，但路径既非本进程 execPath 也不在允许根目录内 -> 拒绝
    assert.throws(
      () => service.registerTask({ taskId: 'abs', targetDir: dir, command: '/usr/bin/node' }),
      VerifyPolicyError,
    )
    // 4. 控制字符注入被拒绝
    assert.throws(
      () => service.registerTask({ taskId: 'ctl', targetDir: dir, command: 'node\n--evil' }),
      VerifyPolicyError,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('自动合并门禁：通过+有证据+失败率达标才允许', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sv-gate-'))
  try {
    const service = new VerificationService(TEST_POLICY)
    service.registerTask({ taskId: 'ok', targetDir: dir, command: process.execPath, args: ['-e', 'process.exit(0)'] })
    const pass = await service.run('ok')

    const allowed = autoMergeAllowed(pass, { attempts: 100, failures: 0 })
    assert.equal(allowed.allowed, true)

    const highFailure = autoMergeAllowed(pass, { attempts: 1000, failures: 10 })
    assert.equal(highFailure.allowed, false)
    assert.ok(highFailure.reasons.some((r) => r.includes('失败率')))

    const failedReport = { ...pass, passed: false }
    const blocked = autoMergeAllowed(failedReport, { attempts: 10, failures: 0 })
    assert.equal(blocked.allowed, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('测试运行器集成：在目标目录跑 node --test 并产出证据', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sv-suite-'))
  try {
    writeFileSync(
      join(dir, 'smoke.test.mjs'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('ok', () => assert.equal(1, 1));\n",
    )
    const service = new VerificationService(TEST_POLICY)
    const report = await runTestSuite(service, dir, { taskId: 'suite' })
    assert.equal(report.passed, true)
    assert.ok(report.evidence.some((e) => e.kind === 'exit'))
    assert.ok(report.evidence.length >= 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
