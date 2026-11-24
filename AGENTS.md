# AGENTS.md · SOUL-Viking 工程约束

本文件是给所有在本仓库工作的 Agent / 贡献者的硬性约束。
任何违反约束的改动都应被 CI / 验证 Agent 直接拒绝，而不是靠评审记忆。

## 来源署名（许可硬性要求，不得移除）

`dsh-soul/` 是 **danshuyue/dsh-agent-soul v0.10.6** 的完整原样内嵌（作者 单树见月；其记忆/心情
内核派生自 Yuuyuko-uu 的 dsh-fish-memory / dsh-feiyu-mood），适用《Yuuyuko-uu 插件许可 1.2》
（全文 `LICENSE` 与 `dsh-soul/LICENSES/`）。再分发必须：保留许可原文、README 第一屏署名、
说明改动、不得声称原创、衍生作品沿用同许可。

## 定位红线（最高优先级）

本仓库是宿主 Agent（Codex / Hermes）的**私人秘书**：灵魂（人格+记忆+心情+日记）+ 提示词注入 +
极简记忆库 + 外部工具派发员。

- **不许修改 `dsh-soul/lib/**` 引擎代码**——它是原样移植的上游源码，改了就失去「完整移植」语义，
  也会让 `npm run test:dsh-engine`（上游 93 项测试）失去保真证明作用。引擎行为要调整走它自己的
  配置（`agents/persona.json`，键见 `dsh-soul/lib/state/cache.js` 的 DEFAULT_CONFIG）。
- **宿主面缺口只补在 `core/dsh/adapter.js`**——模拟 DSH 宿主的 ctx / systemPrompt.context /
  tools.register / llm.stream / agent 事件总线。适配层只许实现引擎读取的接口形状，不许加戏。
- **不许在 MCP 内部实现团队协作**（spawn/orchestrate）——团队归宿主侧 DSH 插件（Sicaduj 版）管。
- **不许在 MCP 内部自建执行器**——`skill_execute` 只返回派发指引，干活的是宿主生态。
- **任何新依赖、新状态机，先问：引擎或宿主成熟生态里是不是已经有？** 有就登记/接线，没有才考虑写。

## 分层与铁律

```
灵魂引擎      dsh-soul/lib/**       —— danshuyue 版完整引擎（零修改）：衰减记忆卡/心情七情/人格/
                                       笔记/目的/摘录日记/心里话/提取/提炼/保留期/注入六段
宿主适配      core/dsh/adapter.js   —— 模拟 cordis ctx、注入段装配（order 降序）、agent 事件、
                                       llm.stream 桥（接全局串行队列，显存保护）
L1 Soul      core/soul/**          —— MCP 层人格对话与提示词注入，无执行权
L2 Viking    core/viking/**        —— viking:// 存储、L0/L1/L2、目录递归检索（SQLite）
L3 Skill+V   core/skills/** core/verify/** —— 意图路由、派发指引、验证闭环、合并门禁
门面/装配     core/facade.ts
MCP 协议/工具 mcp_server/**（tools/call 串行队列）
```

铁律（不可违反）：

1. **Soul 层无执行权**：`core/soul/**` 不得 import `node:fs` / `node:child_process`。
   `tests/soul.test.ts` 的隔离用例守护此约束。
2. **灵魂引擎降级不阻断对话**：引擎装配失败/未配 LLM 时，soulChat 必须照常返回
   （`tests/dsh-soul.test.ts` 降级用例守护）。
3. **显存保护**：所有模型调用（对话/心情判定/记忆提炼/日记/嵌入）必须走 `core/llm.ts` /
   `core/embed.ts` 的全局串行队列，禁止绕过并发直连（本地单卡 3090Ti）。
4. **记忆必须带 URI**（viking 侧）：注入给 Agent 的 viking 记忆一律携带 `viking://` URI。
5. **owner 隔离**：viking 记忆按 owner 分隔，私有记忆对其他 owner 不可见（`tests/security.test.ts`）。
6. **验证证据不可伪造**：证据必须来自真实运行（退出码/日志/耗时）；`command` 与 `target_dir`
   双白名单防 RCE。
7. **自动合并门禁**：`passed && evidence 非空 && 历史失败率 <= 0.5%` 才允许 `auto_merge`。

## 目录约定

- `dsh-soul/`：上游引擎，只读（见红线）。数据落 `<SOULVIKING_HOME>/dsh-soul/agents/`
  （记忆卡/心情/笔记/日记/persona.json/soul.log），路径口径见 `dsh-soul/lib/paths.js`。
- `souls/*.SOUL.md`：MCP 层人格定义（与引擎的 AGENT.md 人格并存，互不覆盖）。
- `skills/registry.json`：外部能力目录（dispatch：external_mcp / command / agent）。
- `tests/*.test.ts`：本仓库集成测试；`dsh-soul/tests/`：引擎上游测试（保真证明）。

## 命令

- 本仓库测试：`npm test`（51 项）
- 引擎保真测试：`npm run test:dsh-engine`（93 项；已知上游自带 1 条 mtime 时序抖动：
  notes「手动改过的正文，摘要会重新算」，上游原版同样偶发，与移植无关）
- 类型检查：`tsc --noEmit -p tsconfig.json`
- 启动 MCP：`npm start`（stdio；stdout 仅协议输出）

## 非目标 / 已知替换点

- 默认模型客户端为**离线确定性**实现；生产设 `SOULVIKING_LLM_BASE_URL`（本地 qwen3.8）。
  未配 LLM 时引擎心情判定不跑、记忆原话直存（引擎文档化降级行为）。
- `dsh-soul/lib/client*`、`lib/http/**`（Web 设置页）随包保留但未接线（DSH 宿主 Web UI 专属）。
- Node 直接运行 `.ts`（strip-only 模式）：**禁用** parameter properties（`constructor(private x)`）、
  enum、namespace——会抛 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。引擎是纯 JS 不受此限。
