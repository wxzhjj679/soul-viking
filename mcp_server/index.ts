// stdio 入口：启动 SOUL-Viking MCP Server。
// 注意：stdout 仅用于 MCP 协议输出；这里所有诊断信息都写 stderr。

import { SoulViking } from '../core/facade.ts'
import { serveStdio } from './protocol.ts'
import { buildTools } from './tools.ts'

const facade = new SoulViking()
// DSH 灵魂引擎惰性装配：工具清单要包含引擎注册的四个工具（soul_memory/goal/note/diary），
// 所以启动时先等引擎就绪；装配失败降级为空清单（对话链路不受影响，facade 内部会再兜一层）。
const dshTools = await facade.dshTools()
const tools = buildTools(facade, dshTools)

serveStdio({ name: 'soul-viking', version: '0.1.0', tools })

console.error(
  `[soul-viking] ready · tools=${tools.length} · personas=${facade.listPersonas().length} · skills=${facade.skillsRegistrySize} · dsh-soul=${dshTools.length > 0 ? 'on' : 'off'}`,
)

const shutdown = (): void => {
  try {
    facade.close()
  } catch {
    // 忽略关闭期错误
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.stdin.on('end', shutdown)
