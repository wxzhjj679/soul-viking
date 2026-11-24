// 宿主适配层：让 danshuyue/dsh-agent-soul 引擎跑在没有 cordis/DSH 的环境（本 MCP Server）里。
//
// ── 移植原则（对着仓库里的每一行说话）──
//   dsh-soul/lib/** 引擎代码**原样零修改**（含全部注释与许可证头）。
//   本文件只模拟 DSH 宿主向插件提供的最小宿主面，全部形状抄自引擎自己的读取代码：
//     · ctx.get(name) / ctx[name]      —— serviceOf（env.js）的两条取用路径
//     · ctx.effect(fn, name)           —— entry.js / segment-*.js 的生命周期挂载
//     · ctx.on(...)                    —— 装配证词（attest）；MCP 侧无装配事件流，no-op
//     · systemPrompt.context(def)      —— 注入段注册（name/order/required/text(context)）
//     · tools.register(def)            —— 工具注册（parameters/output/execute(args, context)）
//     · llm.stream(params)             —— 异步可迭代 {type:'text-delta'} 流（core/llm-stream.js 消费）
//     · llm.createUserMessage(...)     —— inject.js 语气投递的兜底前置
//     · agent.session.header.{id,cwd} / session.seq / session.snapshotEvents(from,to)
//       / session.events[]             —— turns.js / extract.js 的事件读取双路径
//     · agent.inbox.append(kind,msg)   —— 语气注入（registerToneForTurn）
//     · agent.ctx.on('agent/inbox/inserted' | 'agent/turn-stopping')  —— mood/hooks.js
//     · agent.options.{provider,model} —— mood/session.js sessionModelOf 的第二判据
//
// ── 显存保护 ──
//   llm.stream 桥接到 soul-viking 的 OpenAICompatibleModel —— 它内部走全局串行互斥队列，
//   心情判定 / 记忆提炼 / 日记的模型调用与对话共用同一条串行通道，本地单卡不会被并发打爆。
//   未配置 SOULVIKING_LLM_BASE_URL 时 llm 服务传 undefined，引擎按它自己的降级路径走
//   （「宿主没有 llm 服务：心情判断不跑，记忆只在过滤后原话直存」—— entry.js 原文）。
//
// ── 每轮时序（对齐 DSH 宿主的装配语义）──
//   beginTurn: 落 user 事件 → emit inbox/inserted → 按 order 降序逐段调 text({agent})
//              （段内部自己跑 tick 提取/维护、collectForDiary 日记素材、观察器挂载、语气投递）
//   endTurn:   落 assistant 事件 → emit turn-stopping（心情判定在引擎自己的 judgeChain 上异步串行）

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** DSH 消息 content（块数组或字符串）→ 纯文本。形状抄 extract.js textOfContent。 */
function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((b) => (b?.type === 'text' ? String(b.text ?? '') : '')).join('')
}

/** llm.stream 桥：把引擎的 {provider,model,system,messages,...} 翻译成一次串行队列内的 chat 调用。 */
async function* bridgeStream(client, fallbackModel, params) {
  const msgs = []
  if (params?.system) msgs.push({ role: 'system', content: String(params.system) })
  for (const m of params?.messages ?? []) {
    const role = m?.role === 'assistant' ? 'assistant' : m?.role === 'system' ? 'system' : 'user'
    msgs.push({ role, content: contentToText(m?.content) })
  }
  const request = { model: params?.model || fallbackModel, messages: msgs }
  if (Number.isFinite(params?.maxTokens)) request.maxTokens = params.maxTokens
  if (Number.isFinite(params?.temperature)) request.temperature = params.temperature
  const text = await client.chat(request)
  yield { type: 'text-delta', text }
}

/** agent.ctx 的迷你事件总线（mood/hooks.js 只用到 on/off/两个事件名）。 */
class Bus {
  constructor(log) {
    this.map = new Map()
    this.log = log
  }
  on(name, cb) {
    if (!this.map.has(name)) this.map.set(name, new Set())
    this.map.get(name).add(cb)
    return () => {
      this.map.get(name)?.delete(cb)
    }
  }
  emit(name, payload) {
    for (const cb of this.map.get(name) ?? []) {
      try {
        cb(payload)
      } catch (error) {
        this.log(`事件 ${name} 回调失败：${error instanceof Error ? error.message : error}`)
      }
    }
  }
}

/**
 * 创建并装配 DSH 灵魂引擎。
 * @param {object} options
 * @param {string} options.homeDir      SOULVIKING_HOME（引擎数据落在 <homeDir>/dsh-soul 下）
 * @param {string} [options.dshHome]     直接指定引擎数据目录（想和真 DSH 共用 ~/.dsh 时传它）
 * @param {string} [options.cwd]         会话工作目录（项目人格/项目记忆按它的 slug 归档）
 * @param {object|null} [options.llmClient] 带串行队列的 ModelClient（chat(request)->string）；null=离线降级
 * @param {string} [options.llmModel]    模型名（sessionModelOf 的 agent.options 与 stream 兜底）
 * @param {(msg:string)=>void} [options.log]
 */
export async function createDshSoul(options) {
  const {
    homeDir,
    dshHome,
    cwd = process.cwd(),
    llmClient = null,
    llmModel = 'default',
    log = () => {},
  } = options

  // paths.js 的 dshHome() 每次调用现读 env（函数不是常量），在首次调用前设好即可。
  // 不劫持用户已有的 DSH_HOME 语义：想共用真 DSH 数据就显式传 dshHome。
  process.env.DSH_HOME = dshHome ?? process.env.SOULVIKING_DSH_HOME ?? join(homeDir, 'dsh-soul')

  // 动态 import：确保 DSH_HOME 先落位。引擎模块顶层不读盘，路径全部惰性求值。
  const { apply } = await import('../../dsh-soul/lib/host/runtime.js')
  const store = await import('../../dsh-soul/lib/store.js')
  const toolMod = await import('../../dsh-soul/lib/tool.js')
  const diaryMod = await import('../../dsh-soul/lib/diary.js')
  const paths = await import('../../dsh-soul/lib/paths.js')
  const { setFallbackCwd } = toolMod

  // 宿主原本由 core/registry.js 在装配期建目录；MCP 侧没有这一步，必须显式建，
  // 否则 atomicWrite 的 .tmp 文件在 agents/memory/ 等目录缺失时全部 ENOENT。
  paths.ensureDirs()

  setFallbackCwd(cwd)

  // ---- 宿主面模拟 ----
  const segments = []
  const registeredTools = []
  const disposers = []

  const systemPrompt = {
    context(def) {
      if (segments.some((s) => s.name === def.name)) {
        // 引擎自己按 "already registered" 识别重复注册（segment-*.js 的 catch），保持同款文案
        throw new Error(`context ${def.name} already registered`)
      }
      segments.push(def)
      return () => {
        const i = segments.indexOf(def)
        if (i >= 0) segments.splice(i, 1)
      }
    },
  }

  const tools = {
    register(def) {
      registeredTools.push(def)
      return () => {
        const i = registeredTools.indexOf(def)
        if (i >= 0) registeredTools.splice(i, 1)
      }
    },
  }

  const llm = llmClient
    ? {
        createUserMessage({ content, source }) {
          return { id: randomUUID(), role: 'user', content, source }
        },
        stream(params) {
          return bridgeStream(llmClient, llmModel, params)
        },
      }
    : undefined

  const services = { llm, systemPrompt, tools }
  const ctx = {
    llm,
    systemPrompt,
    tools,
    get: (name) => services[name],
    // 装配证词（attest）依赖宿主的 system-prompt/assemble 事件流；MCP 侧没有装配管线，
    // 提供 no-op 让 entry.js 走过注册（它自己会记一行「证词无法注册」以外的日志路径）。
    on: () => () => {},
    effect: (fn, _name) => {
      let dispose
      try {
        dispose = fn()
      } catch (error) {
        log(`effect 执行失败：${error instanceof Error ? error.message : error}`)
      }
      disposers.push(dispose)
      return dispose
    },
  }

  apply(ctx)

  // ---- 会话模拟（DSH agent 的最小形状）----
  const sessions = new Map()
  let lastContext = null

  function sessionFor(id, sessionCwd) {
    let entry = sessions.get(id)
    if (entry) {
      // cwd 跟随最近一次调用（同一会话换工作区时项目卡也要对上号）
      entry.session.header.cwd = sessionCwd
      return entry
    }
    const events = []
    const bus = new Bus(log)
    const toneInbox = []
    const session = {
      header: { id, cwd: sessionCwd },
      events,
      seq: -1,
      firstLiveSeq: 0,
      snapshotEvents(from, to) {
        return events.filter((e) => e.seq >= from && (to === undefined || e.seq < to))
      },
    }
    const agent = {
      session,
      // sessionModelOf 的第二判据（agent.options.{provider,model}）——心情判定/提炼的模型目标
      options: { provider: 'local', model: llmModel },
      inbox: {
        append(kind, message) {
          toneInbox.push({ kind, message })
          bus.emit('agent/inbox/inserted', { message })
        },
      },
      ctx: bus,
    }
    entry = { agent, session, bus, toneInbox, seqCounter: 0 }
    sessions.set(id, entry)
    return entry
  }

  function appendEvent(entry, type, text, source) {
    const seq = entry.seqCounter++
    entry.session.events.push({
      seq,
      type,
      source,
      payload: { content: [{ type: 'text', text: String(text ?? '') }] },
    })
    entry.session.seq = seq
    return seq
  }

  /**
   * 一轮开始：落用户事件 → inbox 事件 → 装配全部注入段。
   * @returns {Promise<{segments: Array<{name:string,text:string}>, systemText: string, toneMessages: string[]}>}
   */
  async function beginTurn(sessionId, userText, opts = {}) {
    const sessionCwd = typeof opts.cwd === 'string' && opts.cwd !== '' ? opts.cwd : cwd
    const entry = sessionFor(sessionId, sessionCwd)
    appendEvent(entry, 'user/message', userText, { kind: 'user' })
    entry.bus.emit('agent/inbox/inserted', {
      message: { role: 'user', content: [{ type: 'text', text: String(userText ?? '') }], source: { kind: 'user' } },
    })

    // 装配前的语气投递缓冲清零（只收本轮 registerToneForTurn 投的）
    entry.toneInbox.length = 0

    // order 数值大的先装（lib/index.js 头注释的口径：270→260→250→245→240→230）
    const ordered = [...segments].sort((a, b) => (b.order ?? 0) - (a.order ?? 0))
    const parts = []
    for (const seg of ordered) {
      if (typeof seg.text !== 'function') continue
      try {
        const text = await seg.text({ agent: entry.agent })
        if (typeof text === 'string' && text.trim() !== '') parts.push({ name: seg.name, text })
      } catch (error) {
        log(`注入段 ${seg.name} 装配失败：${error instanceof Error ? error.message : error}`)
      }
    }
    lastContext = { agent: entry.agent, session: entry.session }
    return {
      segments: parts,
      systemText: parts.map((p) => p.text).join('\n\n'),
      toneMessages: entry.toneInbox
        .filter((x) => x.kind === 'next-step')
        .map((x) => contentToText(x.message?.content))
        .filter((t) => t !== ''),
    }
  }

  /** 一轮结束：落 assistant 事件 → turn-stopping（心情判定由引擎 judgeChain 异步串行执行）。 */
  async function endTurn(sessionId, assistantText) {
    const entry = sessions.get(sessionId)
    if (!entry) return
    appendEvent(entry, 'assistant/message', assistantText, { kind: 'agent' })
    entry.bus.emit('agent/turn-stopping', {})
  }

  /** 工具执行上下文：execute(args, context) 的 cwdOf/sessionIdOf 从这里取会话头。 */
  function currentContext() {
    return lastContext ?? { session: { header: { id: '', cwd } } }
  }

  return {
    dshHome: process.env.DSH_HOME,
    beginTurn,
    endTurn,
    currentContext,
    /** 引擎注册的工具（soul_memory / soul_goal / soul_note / soul_diary），原样透出。 */
    tools: registeredTools,
    segmentNames: () => segments.map((s) => ({ name: s.name, order: s.order ?? 0 })),
    // 只读观测（全部是引擎自己的导出函数，不另造口径）
    loadConfig: () => store.loadConfig(),
    saveConfig: (patch) => store.saveConfig(patch),
    moodState: (c) => store.moodState(typeof c === 'string' && c !== '' ? c : cwd),
    memoryStats: (c) => store.memoryStats(typeof c === 'string' && c !== '' ? c : cwd, store.loadConfig()),
    globalCard: () => store.globalCard(),
    projectCard: (c) => store.projectCard(typeof c === 'string' && c !== '' ? c : cwd),
    readRecentExcerpts: (days) => diaryMod.readRecentExcerpts(diaryMod.todayKey(Date.now()), days ?? 3),
    dispose() {
      for (const d of disposers) {
        try {
          if (typeof d === 'function') d()
        } catch { /* 卸载失败不阻断 */ }
      }
      sessions.clear()
    },
  }
}
