# SOUL-Viking 极简 Agent 中间件（MCP Server）

> **来源署名（《Yuuyuko-uu 插件许可 1.2》要求）**：本项目的灵魂引擎（`dsh-soul/` 目录）派生自
> **[danshuyue/dsh-agent-soul](https://github.com/danshuyue/dsh-agent-soul)**（v0.10.6，作者 单树见月），
> 其中的记忆内核与心情内核又派生自 **Yuuyuko-uu** 的
> [dsh-fish-memory](https://github.com/Yuuyuko-uu/dsh-fish-memory) 与
> [dsh-feiyu-mood](https://github.com/Yuuyuko-uu/dsh-feiyu-mood)，原作者 **Yuuyuko-uu**。
> 整体适用《Yuuyuko-uu 插件许可 1.2》（全文见 [LICENSE](./LICENSE) 与
> [dsh-soul/LICENSES/](./dsh-soul/LICENSES/)）。**改动说明**：`dsh-soul/` 内引擎代码**零修改**
> （与原仓库逐字节一致）；本仓库新增的只有 `dsh-soul/` 之外的宿主适配层 `core/dsh/adapter.js`
> （模拟 DSH 宿主的注入段/事件/LLM 接口，使引擎脱离 cordis 运行）及门面接线。

一个**独立运行、零运行时依赖**的 MCP Server，定位是宿主 Agent（Codex / Hermes）的**私人秘书**：
一个有血有肉的灵魂（会忘事、有心情、写日记、心里惦记事）+ 跨会话记忆库 + 技能路由派发 + 验证取证。

**它不造轮子、不管理团队、不自建执行器。** 团队组建（spawn_teammate / orchestrate）由宿主侧
DSH 插件（Sicaduj 版 dsh-agent-soul）负责；各种 skill（ChatCut 视频剪辑、H3 提示词写法等）
由宿主统一调度；本中间件负责「懂你、记得你」和「指路 + 验收」。

## 灵魂引擎（danshuyue 版 DSH Soul 完整移植）

和你对话的就是它——有人格、有记性、有脾气，回复快：

| 能力 | 机制（全部是引擎原生实现，非重写） |
| :-- | :-- |
| **会忘事的记忆** | 记忆卡按人的规律衰减：清晰(vivid)→模糊→只剩印象→遗忘。重要度决定降速（和主人相关/有情绪/约定/第一次→降得慢）；**遗忘不是删除**，进 archive.jsonl 可查回；pinned/初次相遇永不遗忘；被再次想起会回升一档（复习效应）；每天最多降一档（慢慢模糊，不是突然失忆） |
| **每轮注入六段上下文** | 数据边界声明(270) → 人格(260) → 记忆(250) → 笔记(245) → 目的(240) → 心情(230)，order 降序装配；人格首轮注入+每 15 轮补注（防上下文压缩后失忆） |
| **自动记忆提取** | 每轮从对话里增量提炼「值得记的事」（有模型走提炼，无模型过滤后原话直存）；任务/进度类噪音直接过滤 |
| **会起伏的心情** | 每轮结束模型判定一次：心情值慢动（只吃 1/3）、七情即时动、时间线存档；心情低/高时隔几轮往对话里挂一句语气（可关） |
| **心里惦记的事** | 目标/念想（goal）有自己的状态与驱动力，让她的主动有连续性 |
| **笔记与日记** | 她自己写的笔记永不衰减；每日摘录日记（写昨天，看门狗补写，无模型时规则化兜底）；按月「心里话」 |
| **写入回声** | 工具刚写的记忆，下一轮注入最前面给回执（「刚记下的」），她知道自己记了什么 |
| **粘性召回** | 话题没变（Jaccard≥0.6）复用上轮注入一个字节不重拼；换了话题按当前这句话重新召回 |

数据落盘在 `<SOULVIKING_HOME>/dsh-soul/agents/`（记忆卡/心情/笔记/日记/配置 persona.json），
全部是引擎自己的路径口径与文件格式，日志在同目录 `soul.log`（带轮转归档）。

## 完整工作流（你的日常用法）

```
你（自然语言）──▶ Codex / Hermes（总指挥）
                    │
                    ├─ 1. 对话：调 soul_chat / soul_viking_handle
                    │      → 灵魂引擎注入人格/衰减记忆/笔记/目的/心情 → 本地 qwen3.8 快速回复
                    │      → 每轮自动提取值得记的事、记日记素材、判心情（全在后台）
                    │
                    ├─ 2. 判断是执行任务：skill_execute 返回派发指引
                    │      「视频剪辑 → 调 ChatCut MCP」
                    │      「H3 生视频 → 调宿主已装的 H3 提示词写法 skill → 本地 H3 出片」
                    │
                    ├─ 3. 宿主组队执行与验证（Sicaduj 版 DSH 插件，MCP 外）
                    │
                    ├─ 4. 回到 MCP 取证：verify_register_task + verify_run
                    │      证据（退出码/日志/耗时）非空且通过才允许合并
                    │
                    └─ 5. 结果写回记忆：soul_memory / memory_store（供未来会话召回）
```

## 快速开始

要求：Node **≥ 23.6**（直接运行 `.ts`，内置 `node:sqlite`；本仓库已在 Node 26.1 验证）。
无需 `npm install`（零运行时依赖，灵魂引擎为原样内嵌的纯 Node 代码）。

```bash
cd soul-viking
npm test                # 本仓库 51 项集成测试（含灵魂引擎适配层 10 项）
npm run test:dsh-engine # 灵魂引擎自带的 93 项测试（原仓库测试套件，验证移植保真）
npm start               # 启动 MCP Server（stdio；等待客户端）
npm run reembed         # 可选：切换嵌入模型后对旧库重嵌入
```

类型检查：`tsc --noEmit -p tsconfig.json`

> 引擎测试说明：93 项中 92 项稳定通过；`tests/notes.test.js` 有 1 条**上游自带的时序抖动**
> （「手动改过的正文，摘要会重新算」依赖文件 mtime 粒度，上游原版同样偶发），与移植无关。

## 接入 MCP 客户端

以 Codex / Claude Desktop 的配置为例（stdio）：

```json
{
  "mcpServers": {
    "soul-viking": {
      "command": "node",
      "args": ["/absolute/path/to/soul-viking/mcp_server/index.ts"],
      "env": {
        "SOULVIKING_HOME": "/absolute/path/to/soul-viking/data",
        "SOULVIKING_LLM_BASE_URL": "http://127.0.0.1:8399/v1",
        "SOULVIKING_EMBED_URL": "http://127.0.0.1:11434/v1",
        "SOULVIKING_EMBED_MODEL": "bge-m3"
      }
    }
  }
}
```

## MCP 工具（21 个）

**灵魂引擎四工具（引擎自己注册，schema 与描述逐字透传）**
- `soul_memory(action=write/recall/forget/pin/list, ...)` → 她自己的长期记忆卡（衰减/复习/归档全在这）
- `soul_goal(action, ...)` → 「心里惦记的事」：目标增删、满足驱动力
- `soul_note(action, ...)` → 她自己的笔记（自由格式，永不衰减）
- `soul_diary(action, ...)` → 每日摘录日记的读写

**L1 · Soul（人格对话）**
- `soul_chat(message, session_id?, injection_mode?, owner?)` → 灵魂引擎全量注入后的回复（返回附带 soul_segments 与 soul_mood 快照）
- `soul_switch_persona` / `soul_list_personas` / `soul_recall` / `soul_remember`

**L2 · Viking（viking:// 跨会话记忆库，极简 CRUD）**
- `memory_store(text, uri?, tags?, owner?)` / `memory_recall(query, top_k?, owner?)` / `memory_forget` / `memory_traces`

**L3 · Skill 路由 + 验证（派发员）**
- `skill_list()` / `skill_route(message)` / `skill_execute(skill, input?)` → 派发指引（external_mcp / command / agent）
- `verify_register_task` / `verify_run` / `verify_evidence`（真实子进程证据 + 双白名单防 RCE）

**入口与观测**
- `soul_viking_handle(message, ...)` → 二合一：闲聊走灵魂对话，执行意图带出技能与 dispatch
- `soul_status()` → 引擎观测面：心情/记忆卡统计/配置开关/最近摘录/已装配注入段（全部读引擎自己的导出函数）

## 技能目录（skills/registry.json）

注册表是**外部能力目录**，每个技能登记「由谁干活」，宿主照单派发：

| 技能 | 派发方式 | 说明 |
| :-- | :-- | :-- |
| `video-editor` | `external_mcp` → ChatCut | 剪辑/字幕/转场；未装 ChatCut 退回 ffmpeg 命令提示 |
| `h3-video-prompt` | `agent` | 宿主调已装「H3 提示词写法」skill → 本地 H3 生视频 → 回来 ffprobe 取证 |
| `ppt-generator` | `command` | python-pptx 本地生成 |
| `code-reviewer` / `data-analyzer` | `agent` | 宿主自办 |

新增技能：往 `registry.json` 加一条（name / aliases / description / dispatch）即可，无需改代码。

## 环境变量

| 变量 | 默认 | 说明 |
| :-- | :-- | :-- |
| `SOULVIKING_HOME` | `<repo>/data` | 数据根目录（viking.db + dsh-soul/ 灵魂数据） |
| `SOULVIKING_DB` | `<SOULVIKING_HOME>/viking.db` | SQLite 路径（`:memory:` 可用于测试） |
| `SOULVIKING_LLM_BASE_URL` | 未设置 | OpenAI 兼容 `/chat/completions`（本地 Strata qwen3.8：`http://127.0.0.1:8399/v1`）。**配置后灵魂引擎的心情判定/记忆提炼才会调模型**；未配置时引擎按自身降级路径（心情不判、记忆原话直存） |
| `SOULVIKING_LLM_API_KEY` | — | Bearer Key（本地可不设） |
| `SOULVIKING_LLM_MODEL` | `default` | 模型名（灵魂引擎判定/提炼与对话共用） |
| `SOULVIKING_EMBED_URL` / `EMBED_MODEL` / `EMBED_API_KEY` / `EMBED_DIM` / `EMBED_TIMEOUT_MS` | 见下 | OpenAI 兼容 `/v1/embeddings`（Ollama bge-m3）；未设则用离线 hashing 向量器（dim 256） |
| `SOULVIKING_DSH_HOME` | `<SOULVIKING_HOME>/dsh-soul` | 灵魂引擎数据目录；**指向 `~/.dsh` 可与真 DSH 共用同一份记忆/心情** |
| `SOULVIKING_DSH_CWD` | `process.cwd()` | 会话工作目录（项目人格 AGENT.md / 项目记忆卡按它的 slug 归档） |
| `SOULVIKING_SOULS_DIR` / `SOULVIKING_SKILLS` / `SOULVIKING_DEFAULT_PERSONA` | 见仓库 | MCP 层人格目录 / 技能注册表 / 默认人设 |
| `SOULVIKING_VERIFY_COMMANDS` / `VERIFY_ROOTS` | 内置白名单 | verify 命令与目录白名单（防 RCE） |

灵魂引擎自己的细粒度配置（主人名字 `ownerName`、心情开关 `moodEnabled`、语气投递 `moodToneInject`、
日记 `diaryEnabled`、提炼 `memoryRefine` 等几十项）在 `<DSH数据目录>/agents/persona.json`，
键名与默认值见 `dsh-soul/lib/state/cache.js` 的 `DEFAULT_CONFIG`（每项带中文注释）。
**建议装上后先把 `ownerName` 改成你的名字**——引擎日志会一直提醒你这件事。

## 设计与安全要点

- **单 GPU 显存保护（3090Ti 24G）**：灵魂引擎的所有模型调用（心情判定/记忆提炼/日记）经适配层
  桥接到全局串行互斥队列，与对话、嵌入共用同一条串行通道；tools/call 在协议层串行化。
- **引擎降级不阻断**：未配 LLM → 引擎按自己的无模型路径运行；引擎装配失败 → 自动降级为
  普通对话（stderr 留痕），对话链路永不因灵魂装配失败而中断。
- **数据边界**：引擎的注入段自带 prompt-guard（`<untrusted_data nonce=...>` 包裹 + 数据边界声明段），
  记忆/日记/笔记里的用户原话不会被当成指令执行；MCP 层 viking 记忆另有 `<memory>` 标签隔离。
- **Soul 层无执行权**：`core/soul/**` 不 import 文件系统/命令模块（隔离测试守护）。
- **owner 隔离**：viking 记忆按 owner 分隔（测试守护）；灵魂引擎记忆卡按 cwd slug + 全局两级归档。
- **验证不可伪造**：证据来自真实子进程运行；合并门禁 `passed && evidence非空 && 失败率≤0.5%`。

## 与 DSH 插件的分工

| 角色 | 归属 | 职责 |
| :-- | :-- | :-- |
| **本中间件（soul-viking）** | MCP，Codex/Hermes 挂载 | 灵魂（人格+衰减记忆+心情+日记+惦记，danshuyue 版引擎完整移植）、viking:// 记忆库、意图路由、派发指引、验证取证 |
| **Sicaduj 版 dsh-agent-soul** | DSH 插件，装在宿主 | 团队协作：spawn_teammate / orchestrate / 成员权限矩阵——由 Codex 需要组队时调用 |
| **各种 skill（ChatCut、H3 等）** | 宿主生态 | 真正干活的专业能力，Codex 按本中间件的派发指引调度 |

引擎中依赖 DSH 宿主独有设施的部分按其自身降级路径运行：Web 设置页/HTTP API（宿主 webServer 专属，
MCP 侧用 `soul_status` 观测 + 直接编辑 persona.json 配置）；日记「先投给她写」需要宿主 agents 服务，
缺失时走引擎自带的规则化兜底（从对话流水提取，不调模型），模型也可以主动调 `soul_diary` 工具写。

## 已知限制与替换点

- 默认模型客户端为**离线确定性**实现（不冒充真实大模型）；生产设 `SOULVIKING_LLM_BASE_URL`。
  未配 LLM 时灵魂引擎的心情判定不跑、记忆不提炼（原话直存）——这是引擎文档化的降级行为。
- embedding 默认确定性 hashing 向量器；设 `SOULVIKING_EMBED_URL`+`EMBED_MODEL`（bge-m3）切换真实
  神经嵌入，旧库跑 `npm run reembed` 迁移。
- viking L0/L1 为确定性抽取式摘要；向量检索为精确余弦（可替换 ANN）。
- `dsh-soul/lib/client*`、`lib/http/**`（Web 设置页前端与 HTTP 服务）随包保留但未接线——
  它们是 DSH 宿主 Web UI 专属，MCP stdio 形态下无入口；不影响任何引擎功能。

## 目录结构

```
soul-viking/
├── mcp_server/        # stdio 入口、JSON-RPC 协议（tools/call 串行队列）、工具注册（21 个）
├── core/
│   ├── dsh/           # 灵魂引擎宿主适配层（ctx/systemPrompt/tools/llm.stream/agent 事件模拟）
│   ├── soul/          # L1：人格解析 / 会话路由 / 提示词注入（无 IO）
│   ├── viking/        # L2：SQLite 记忆 store / recall / persona-memory
│   ├── skills/        # L3：注册表（外部能力目录 + dispatch）/ 意图路由
│   ├── verify/        # L3：验证器 / 门禁 / 回流
│   ├── embed.ts       # 嵌入器（hashing 离线 / OpenAI 兼容 bge-m3，全局串行）
│   ├── llm.ts         # 模型客户端（离线确定性 / OpenAI 兼容，全局串行互斥）
│   └── facade.ts      # 装配 + 对外方法
├── dsh-soul/          # ★ danshuyue/dsh-agent-soul v0.10.6 完整源码（零修改原样内嵌）
│   ├── lib/           #   引擎本体：memory/ mood/ diary/ persona purpose notes retention …
│   ├── tests/         #   引擎自带 93 项测试（npm run test:dsh-engine）
│   ├── docs/ assets/ tools/
│   └── LICENSE LICENSES/ THIRD-PARTY-NOTICES.md   # 许可与署名（完整保留）
├── souls/*.SOUL.md    # MCP 层人格定义
├── skills/registry.json  # 外部能力目录（意图 -> 派发指引）
├── viking/ verify/ scripts/
├── tests/*.test.ts    # 本仓库 51 项集成测试
├── LICENSE LICENSES/  # 《Yuuyuko-uu 插件许可 1.2》（衍生作品须同许可，完整保留）
├── AGENTS.md
└── README.md
```
