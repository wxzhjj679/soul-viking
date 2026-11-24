// 最小 MCP Server 协议实现：JSON-RPC 2.0 over stdio（换行分隔 JSON）。
// 零第三方依赖。仅实现 MCP 必需子集：initialize / tools/list / tools/call / ping 等。
// 关键约束：stdout 只能输出协议消息；所有日志走 stderr。

export interface ToolRegistration {
  name: string
  description: string
  inputSchema: unknown
  handler: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

export interface ServeOptions {
  name: string
  version: string
  tools: ToolRegistration[]
  defaultProtocolVersion?: string
}

export interface Stdio {
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

function toText(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

export function serveStdio(
  options: ServeOptions,
  io: Stdio = { stdin: process.stdin, stdout: process.stdout },
): void {
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]))
  let buffer = ''

  // tools/call 串行队列：按到达顺序逐个执行工具（存储/检索类工具异步化后，
  // 并发交错会破坏「先 store 后 recall」这类客户端连发场景的因果顺序）。
  // initialize / tools/list 等元数据方法不入队，长任务不会阻塞握手。
  let callQueueTail: Promise<void> = Promise.resolve()
  const enqueueToolCall = (run: () => Promise<void>): void => {
    callQueueTail = callQueueTail.then(run, run)
  }

  const write = (obj: unknown): void => {
    io.stdout.write(`${JSON.stringify(obj)}\n`)
  }
  const reply = (id: JsonRpcMessage['id'], result: unknown): void => {
    write({ jsonrpc: '2.0', id, result })
  }
  const replyError = (id: JsonRpcMessage['id'], code: number, message: string): void => {
    write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  const dispatch = async (msg: JsonRpcMessage): Promise<void> => {
    if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') return
    const id = msg.id
    const isNotification = id === undefined
    const params = msg.params ?? {}

    try {
      switch (msg.method) {
        case 'initialize': {
          if (isNotification) return
          const requested = params.protocolVersion
          const protocolVersion =
            typeof requested === 'string' ? requested : (options.defaultProtocolVersion ?? '2025-06-18')
          reply(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: options.name, version: options.version },
            instructions:
              'SOUL-Viking 中间件：Soul 对话 / Viking 分层记忆 / Agent 团队执行 / 技能路由 + 验证闭环。',
          })
          return
        }
        case 'notifications/initialized':
        case 'initialized':
          return
        case 'ping':
          if (!isNotification) reply(id, {})
          return
        case 'tools/list':
          if (isNotification) return
          reply(id, {
            tools: options.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
          })
          return
        case 'resources/list':
          if (!isNotification) reply(id, { resources: [] })
          return
        case 'prompts/list':
          if (!isNotification) reply(id, { prompts: [] })
          return
        case 'logging/setLevel':
          if (!isNotification) reply(id, {})
          return
        case 'tools/call': {
          if (isNotification) return
          const name = params.name
          const rawArgs = params.arguments
          const args =
            rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : {}
          enqueueToolCall(async () => {
            const tool = typeof name === 'string' ? byName.get(name) : undefined
            if (!tool) {
              reply(id, { content: [{ type: 'text', text: `未知工具：${String(name)}` }], isError: true })
              return
            }
            try {
              const result = await tool.handler(args)
              reply(id, { content: [{ type: 'text', text: toText(result) }] })
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              reply(id, { content: [{ type: 'text', text: `错误：${message}` }], isError: true })
            }
          })
          return
        }
        default:
          if (!isNotification) replyError(id, -32601, `未实现的方法：${msg.method}`)
          return
      }
    } catch (error) {
      if (!isNotification) replyError(id, -32603, error instanceof Error ? error.message : String(error))
    }
  }

  const handleLine = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 解析失败' } })
      return
    }
    void dispatch(parsed as JsonRpcMessage)
  }

  if (typeof io.stdin.setEncoding === 'function') io.stdin.setEncoding('utf8')
  io.stdin.on('data', (chunk: Buffer | string) => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      handleLine(line)
      index = buffer.indexOf('\n')
    }
  })
  io.stdin.on('end', () => {
    if (buffer.trim()) handleLine(buffer)
    buffer = ''
  })
}
