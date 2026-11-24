// L4 · 验证 Agent：在真实运行环境中执行命令并采集可审计证据。
// 只读代码库：本模块只在 targetDir 下 spawn 命令、捕获 stdout/stderr，绝不写入源码。
// 证据来自实际运行（退出码 / 日志 / 耗时），不接受生成 Agent 的自述。
// 安全策略：命令白名单 + 目标目录收敛 + env 过滤，注册与运行前硬校验，
//           防止 MCP 面（verify_register_task）退化为任意命令执行入口。

import { spawn } from 'node:child_process'
import { basename, resolve, sep } from 'node:path'

export type EvidenceKind = 'command' | 'exit' | 'stdout' | 'stderr' | 'duration' | 'timeout' | 'spawn_error'

export interface Evidence {
  kind: EvidenceKind
  detail: string
  value?: string | number
}

export interface Failure {
  reason: string
  detail?: string
}

export interface VerificationReport {
  taskId: string
  passed: boolean
  command: string
  exitCode: number | null
  durationMs: number
  evidence: Evidence[]
  failures: Failure[]
  startedAt: string
  finishedAt: string
}

export interface VerifyTask {
  taskId: string
  targetDir: string
  command: string
  args?: string[]
  timeoutMs?: number
  env?: Record<string, string>
}

const MAX_CAPTURE = 8000

// ---- 安全策略配置（环境变量可覆盖）----
//   SOULVIKING_VERIFY_COMMANDS  逗号分隔的命令白名单（默认：常见测试/构建 runner）
//   SOULVIKING_VERIFY_ROOTS     逗号分隔的目标根目录（默认：服务进程 cwd）
const DEFAULT_ALLOWED_COMMANDS = [
  'npm', 'pnpm', 'yarn', 'npx', 'node', 'deno', 'bun',
  'python', 'python3', 'pytest', 'tsc', 'vitest', 'jest', 'make', 'go', 'cargo',
]
const MAX_ALLOWED_TIMEOUT_MS = 10 * 60_000
const ENV_KEY_ALLOW = /^(NODE_ENV|CI|SOULVIKING_[A-Z0-9_]+)$/

/** 可注入的安全策略；缺省字段回落到环境变量，再回落到内置默认值。 */
export interface VerifyPolicy {
  allowedCommands?: string[]
  allowedRoots?: string[]
  maxTimeoutMs?: number
}

export class VerifyPolicyError extends Error {
  constructor(message: string) {
    super(`验证任务被安全策略拒绝：${message}`)
    this.name = 'VerifyPolicyError'
  }
}

function envList(name: string, fallback: string[]): string[] {
  const raw = process.env[name]
  if (!raw || !raw.trim()) return fallback
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function resolveVerifyPolicy(policy: VerifyPolicy = {}): Required<VerifyPolicy> {
  return {
    allowedCommands: policy.allowedCommands ?? envList('SOULVIKING_VERIFY_COMMANDS', DEFAULT_ALLOWED_COMMANDS),
    allowedRoots: (policy.allowedRoots ?? envList('SOULVIKING_VERIFY_ROOTS', [process.cwd()])).map((r) => resolve(r)),
    maxTimeoutMs: policy.maxTimeoutMs ?? MAX_ALLOWED_TIMEOUT_MS,
  }
}

/** env 透传只保留安全键（防调用方覆盖 PATH / 注入密钥类变量）。 */
export function sanitizeTaskEnv(env?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env ?? {})) {
    if (ENV_KEY_ALLOW.test(key) && typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * 注册与运行前的硬校验（单一事实来源，MCP 层与服务层共用）：
 *  1. command 的可执行名必须在白名单内；带路径时仅放行本进程 execPath
 *     或位于允许根目录内的路径（禁任意路径的可执行文件）；
 *  2. targetDir 必须收敛在允许的根目录内（resolve 后前缀校验，防 ../ 逃逸）；
 *  3. 所有字符串字段禁控制字符；timeout 有上限。
 */
export function validateVerifyTask(task: VerifyTask, policy?: VerifyPolicy): void {
  const p = resolveVerifyPolicy(policy)
  for (const field of [task.taskId, task.targetDir, task.command, ...(task.args ?? [])]) {
    if (/[\0\n\r]/.test(field)) throw new VerifyPolicyError('字段包含非法控制字符（\\0 / \\n / \\r）')
  }
  const command = task.command.trim()
  const base = basename(command)
  if (!base || !p.allowedCommands.includes(base)) {
    throw new VerifyPolicyError(
      `命令 "${base || command}" 不在白名单内（当前白名单：${p.allowedCommands.join(', ')}；可用 SOULVIKING_VERIFY_COMMANDS 配置）`,
    )
  }
  if (base !== command) {
    const cmdPath = resolve(command)
    const trusted = cmdPath === resolve(process.execPath) || p.allowedRoots.some((root) => cmdPath.startsWith(root + sep))
    if (!trusted) {
      throw new VerifyPolicyError(`command 带路径时只允许本进程可执行文件或允许根目录内的路径，收到 "${command}"`)
    }
  }
  const targetDir = resolve(task.targetDir)
  if (!p.allowedRoots.some((root) => targetDir === root || targetDir.startsWith(root + sep))) {
    throw new VerifyPolicyError(`target_dir "${task.targetDir}" 不在允许的根目录内（允许：${p.allowedRoots.join(', ')}）`)
  }
  if (task.timeoutMs !== undefined && (task.timeoutMs <= 0 || task.timeoutMs > p.maxTimeoutMs)) {
    throw new VerifyPolicyError(`timeout_ms 必须在 (0, ${p.maxTimeoutMs}] 范围内`)
  }
}

interface ProcessOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  spawnError?: string
}

function cap(text: string): string {
  return text.length > MAX_CAPTURE ? `${text.slice(0, MAX_CAPTURE)}\n…[truncated]` : text
}

function runProcess(task: VerifyTask): Promise<ProcessOutcome> {
  return new Promise((resolve_) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let child
    try {
      child = spawn(task.command, task.args ?? [], {
        cwd: task.targetDir,
        env: { ...process.env, ...sanitizeTaskEnv(task.env) },
        stdio: ['ignore', 'pipe', 'pipe'],
        // 独立进程组：超时可整组 SIGKILL，防 npm/pytest 等派生的孙进程变孤儿继续跑。
        detached: true,
      })
    } catch (error) {
      resolve_({ exitCode: null, stdout: '', stderr: '', timedOut: false, spawnError: String(error) })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (child?.pid) process.kill(-child.pid, 'SIGKILL')
        else child?.kill('SIGKILL')
      } catch {
        child?.kill('SIGKILL')
      }
    }, task.timeoutMs ?? 30_000)
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    child.on('error', (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve_({ exitCode: null, stdout: cap(stdout), stderr: cap(stderr), timedOut, spawnError: error.message })
    })
    child.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve_({ exitCode: code, stdout: cap(stdout), stderr: cap(stderr), timedOut })
    })
  })
}

export class VerificationService {
  private readonly tasks = new Map<string, VerifyTask>()
  private readonly reports = new Map<string, VerificationReport>()
  private readonly policy: VerifyPolicy

  constructor(policy: VerifyPolicy = {}) {
    this.policy = policy
  }

  registerTask(task: VerifyTask): void {
    validateVerifyTask(task, this.policy)
    this.tasks.set(task.taskId, task)
  }

  getTask(taskId: string): VerifyTask | undefined {
    return this.tasks.get(taskId)
  }

  report(taskId: string): VerificationReport | undefined {
    return this.reports.get(taskId)
  }

  evidence(taskId: string): Evidence[] {
    return this.reports.get(taskId)?.evidence ?? []
  }

  async run(taskId: string, override?: VerifyTask): Promise<VerificationReport> {
    const task = override ?? this.tasks.get(taskId)
    if (!task) throw new Error(`verify_run: 未知任务 ${taskId}`)
    // 运行前再次校验：策略（白名单/根目录）可能在注册后被收紧。
    validateVerifyTask(task, this.policy)
    const startedMs = Date.now()
    const startedAt = new Date().toISOString()
    const evidence: Evidence[] = []
    const failures: Failure[] = []

    const commandLine = [task.command, ...(task.args ?? [])].join(' ').trim()
    evidence.push({ kind: 'command', detail: commandLine })

    const outcome = await runProcess(task)
    const durationMs = Date.now() - startedMs

    if (outcome.spawnError) {
      evidence.push({ kind: 'spawn_error', detail: outcome.spawnError })
      failures.push({ reason: '命令启动失败', detail: outcome.spawnError })
    }
    if (outcome.timedOut) {
      evidence.push({ kind: 'timeout', detail: `超过 ${task.timeoutMs ?? 30_000}ms 超时` })
      failures.push({ reason: '执行超时' })
    }
    evidence.push({ kind: 'exit', detail: `exit=${outcome.exitCode ?? 'null'}`, value: outcome.exitCode ?? -1 })
    if (outcome.stdout.trim()) evidence.push({ kind: 'stdout', detail: outcome.stdout })
    if (outcome.stderr.trim()) evidence.push({ kind: 'stderr', detail: outcome.stderr })
    evidence.push({ kind: 'duration', detail: `${durationMs}ms`, value: durationMs })

    if (outcome.exitCode !== 0 && !outcome.spawnError) {
      const errorLines = outcome.stderr
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /error|fail|exception|assert|✖/i.test(l))
        .slice(0, 10)
      if (errorLines.length > 0) {
        for (const line of errorLines) failures.push({ reason: '运行输出包含错误', detail: line.slice(0, 300) })
      } else {
        failures.push({ reason: `非零退出码 ${outcome.exitCode ?? 'null'}` })
      }
    }

    const passed =
      !outcome.spawnError &&
      !outcome.timedOut &&
      outcome.exitCode === 0 &&
      evidence.some((e) => e.kind === 'exit') &&
      evidence.length > 0

    const report: VerificationReport = {
      taskId,
      passed,
      command: commandLine,
      exitCode: outcome.exitCode,
      durationMs,
      evidence,
      failures,
      startedAt,
      finishedAt: new Date().toISOString(),
    }
    this.reports.set(taskId, report)
    return report
  }
}
