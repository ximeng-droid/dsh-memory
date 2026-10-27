/**
 * dsh-memory — 宿主半边（插件外壳）
 *
 * 只做四件事：
 *   1. 往每轮请求里注入一小段记忆（systemPrompt.context，order 300）；
 *   2. 注册四个工具，让模型能主动查/写/审记忆；
 *   3. 注册 /memory 斜杠命令，用户手敲；
 *   4. 在同一个端口上挂一个面板（/dsh-memory）。
 *
 * 不 import 任何 @deepseek-ai/* 包：磁盘插件解析不到宿主包（宿主包在 app.asar 里），
 * 所以工具定义手写 JSON Schema，不用 defineTool；配置不走 schemastery，自己合并默认值。
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createService } from './service.js'
import { createPanel } from './panel.js'
import { loadConfig, readRawConfig, saveConfig, resolveRoot } from './config.js'
import { listHostSessions, readHostSession } from './history.js'
import { distillOnce, recordsFromSummary } from './distill.js';
import { userGivesRule, worthAsking } from './rules.js';
import {
  appendRaw, appendSummary, buildRecords, dayOf, extractConversation, firstUser, lastUserImages, listSessions, noteDebug, pairLines, pruneRaw, readDebug, readMeta, readRaw, readSummary, shapeOf, summaryLine, userImages, writeMeta, writeRaw, writeSummary } from './sessions.js'

export const name = 'dsh-memory'

/** 这四个服务都真存在（0.2.1-rc.2 已核实）。缺一个就不会 apply，所以别多写。 */
export const inject = ['tools', 'commands', 'systemPrompt', 'webServer', 'workingDirectory']

const BASE = '/dsh-memory'

const HELP = [
  '**/memory** —— 本地记忆库',
  '',
  '- `/memory 状态`：条数与待确认箱',
  '- `/memory 搜索 词`：检索记忆',
  '- `/memory 记下 标题｜正文`：手动记一条（默认进待确认箱）',
  '- `/memory 收下 41` / `/memory 丢弃 41`：处理待确认',
  '- `/memory 检查`：标过期 + 蒸馏旧日记',
  '- `/memory 蒸馏`：把超过 30 天的日记压成一条摘录',
  '- `/memory 归档`：日记攒过 400 行 / 32 KB 就归档（蒸馏 + 移进 _archive）',
  '- `/memory 取代 41 用 43`：让 #43 顶替 #41（更正链；「反悔取代 41」可退回）',
  '- `/memory 诊断`：看抓取/维护/索引最后一次跑的时间与健康色',
  '- `/memory 撤销 2`：撤回最近几次自动写入（进垃圾桶，可捞回）',
  '- `/memory 建议`：从记忆里看出「该立成硬规则/说话风格」的候选（采纳才写进身份层）',
  '- `/memory 技能 [名字]`：列技能卡，或看某张的全文（只把标题与关键词注入）',
  '- `/memory 身份`：看我记下的「你是谁」',
  '- `/memory 我是 老王`、`/memory 我在 深圳`、`/memory 我用 中文`、`/memory 我说话 直接`、`/memory 原则 …`：设定身份',
  '- `/memory 重建`：重建搜索索引',
  '- `/memory 口令`：重置面板密码',
  '- `/memory 打开`：面板地址',
  '- `/memory 蒸馏 [数量]`：让模型把会话流水压成条目（默认 3 个会话）',
  '- `/memory 补扫 [数量]`：把历史会话搬进来（「重扫」会覆盖已补过的）',
  '- `/memory 向量`：把还没算向量的记忆补齐（没装模型会说建不成）',
].join('\n')

/** 中文类型名 → 内部类型 key；不认识的一律当事实。 */
const TYPE_ALIAS = {
  偏好: 'preference', 禁忌: 'forbidden', 决策: 'decision', 经验: 'experience',
  事实: 'fact', 项目: 'project', 知识: 'knowledge', 地图: 'map', 画像: 'profile',
}

function typeOf(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return 'fact'
  if (TYPE_ALIAS[raw]) return TYPE_ALIAS[raw]
  if (Object.values(TYPE_ALIAS).includes(raw)) return raw
  return 'fact'
}

/** /memory 身份 的输出：先给一行摘要，再给实际注入的样子 */
function personaText(service) {
  const { persona, empty, block } = service.personaPreview()
  if (empty) {
    return '还不知道你是谁。这样告诉我：\n/memory 我是 老王\n/memory 我在 深圳\n/memory 我用 中文\n/memory 我说话 直接，别绕\n/memory 原则 不确定的事直说，别猜'
  }
  return `现在记住的：\n${block}\n\n改它：/memory 我是 …｜我在 …｜我用 …｜我说话 …｜原则 …`
}

/**
 * 宿主/插件会往 messages 里塞 user 角色的「系统文本」（Aegis 路由引导、system-reminder、
 * 时间戳行、记忆注入块…）。这些不是用户说的话，抓它们等于抓空气，还会把真正的用户消息顶掉。
 */
function isInjectedText(text) {
  const t = String(text || '').trim()
  if (!t) return true
  if (/^<AEGIS|AEGIS_DSH_ROUTING_BOOTSTRAP|<system-reminder|<hindsight_knowledge/i.test(t)) return true
  if (/^<<<MY-|^<<<MEMORY/.test(t)) return true
  if (/^Time sampled while preparing turn/.test(t)) return true
if (/^Current runtime context/i.test(t)) return true
if (/^Elapsed since the preceding/.test(t)) return true
  if (/^\[model changed/i.test(t)) return true
  return false
}

/** 从 messages 里取最后一条「真人说的」用户文本与最后一条助手文本。 */
function lastPair(messages) {
  if (!Array.isArray(messages)) return { user: '', assistant: '' }
  let user = ''
  let assistant = ''
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (!m || typeof m !== 'object') continue
    const role = m.role ?? m.message?.role
    const content = m.content ?? m.message?.content
    const text = flatten(content)
    if (!text) continue
    if (role === 'user' && !user) {
      if (isInjectedText(text)) continue
      user = text
    } else if (role === 'assistant' && !assistant) assistant = text
    if (user && assistant) break
  }
  return { user, assistant }
}

function flatten(content) {  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

export function apply(ctx, rawConfig) {
  // 用户在面板里改过位置的话，默认位置的 config.json 里会留一个指针，这里优先认它
  const root = resolveRoot(typeof rawConfig?.root === 'string' ? rawConfig.root : '')

  const log = (...args) => {
    try { ctx.logger?.info?.(`[dsh-memory] ${args.join(' ')}`) } catch {}
  }
  const warn = (...args) => {
    try { ctx.logger?.warn?.(`[dsh-memory] ${args.join(' ')}`) } catch {}
  }

  const service = createService({ root, trigger: 'plugin' })
  log(`仓库 ${root}`)

  // profile 里的 config 只当「首次种子」：磁盘上已经有的键以用户的选择为准，
  // 否则面板里选了「自动」，每次重启都会被 patch 里的 semi 盖回去。
  const seeded = readRawConfig(root);
  for (const [key, value] of Object.entries(rawConfig || {})) {
    if (key === 'root') continue
    if (Object.prototype.hasOwnProperty.call(seeded, key)) continue
    try { service.setConfig({ [key]: value }) } catch (error) { warn(`config ${key} 被忽略：${error?.message ?? error}`) }
  }
  const cfg = service.config()
  log(`写入模式 ${cfg.writeMode}`)

  // 4E-1 · 启动清理：超期原文删掉，摘要与元信息永久留着
  let sessionCfg = { enabled: true, retainDays: 90, scanOnStart: true }
  try {
    const c = (service.config() || {}).sessions || {}
    sessionCfg = { ...sessionCfg, ...c }
    if (sessionCfg.enabled !== false) {
      const pr = pruneRaw(service.store ?? { root }, { days: sessionCfg.retainDays ?? 90 })
      if (pr.removed.length > 0) log(`清理超期原文 ${pr.removed.length} 个（摘要保留）`)
      noteDebug({ root }, { type: 'plugin/start', shape: { retained: pr.kept, removed: pr.removed.length } })
    if (sessionCfg.scanOnStart !== false) setTimeout(() => {
      const dbg = readDebug(sRoot)
      const evs = Array.isArray(dbg?.events) ? dbg.events : []
      const lastScan = [...evs].reverse().find((e) => e.type === 'history/scan')
      const forced = Number(lastScan?.version || 0) < SCAN_VERSION
      void scanHistory({ force: forced, limit: forced ? 200 : 15 })
    }, 5000)
    }
  } catch (error) {
    warn(`启动清理失败：${error?.message ?? error}`)
  }


  // 启动 20 秒后补跑一次蒸馏队列（上次没跑完的）
  setTimeout(() => { try { kickDrain() } catch { /* 忽略 */ } }, 20000)

  // 启动时跑一次维护（标过期 + 蒸馏旧日记）；失败不影响插件本体
  if (cfg.maintenance?.auto !== false) {
    try {
      const r = service.maintain({
        staleDays: cfg.maintenance?.staleDays ?? 90,
        dailyDays: cfg.maintenance?.dailyDays ?? 30,
      })
      if (r.summary !== '没有需要处理的') log(`维护：${r.summary}`)
    } catch (error) {
      warn(`维护任务失败：${error?.message ?? error}`)
    }
  }

  // ── 1. 每轮注入 ────────────────────────────────────────────────────────
  try {
    ctx.systemPrompt.context({
      name: 'memory:recall',
      order: 300,
      interpolate: false,
      text: (context) => {
        try {
          lastCwd = context?.cwd || lastCwd
          const cwd = lastCwd || process.cwd()
          const { block } = service.injection({ cwd })
          return block
        } catch (error) {
          warn(`注入失败：${error?.message ?? error}`)
          return ''
        }
      },
    })
  } catch (error) {
    warn(`systemPrompt.context 注册失败：${error?.message ?? error}`)
  }

  // ── 2. 自动抓取（每 step 结束后看最后一条问答） ────────────────────────
  const seenFile = path.join(root, '.capture-state.json')
  let seen = ''
  try {
    seen = String(JSON.parse(fs.readFileSync(seenFile, 'utf8'))?.last ?? '')
  } catch {}
  const remember = (hash) => {
    seen = hash
    try {
      fs.mkdirSync(root, { recursive: true })
      fs.writeFileSync(seenFile, JSON.stringify({ last: hash }), 'utf8')
    } catch {}
  }

  // 子代理的 step 不该进记忆库：它读的是父会话里已经抓过的材料，写进来就是重复与噪音。
  // 宿主没在文档里写死字段名，所以按几处可能出现的位置都试一遍，并把第一次见到的真实形状落盘留证。
  const debugFile = path.join(root, '.capture-debug.json')
  let debugged = false
  const noteShape = (payload) => {
    if (debugged) return
    debugged = true
    try {
      const keys = Object.keys(payload || {})
      const shapes = {}
      for (const k of keys) {
        const v = payload[k]
        if (v && typeof v === 'object' && !Array.isArray(v)) shapes[k] = Object.keys(v).slice(0, 14)
      }
      // 顺带记下最近 4 条消息的角色/长度/开头，方便判断「最后一条 user 到底是谁说的」
      const tail = Array.isArray(payload?.messages)
        ? payload.messages.slice(-4).map((m) => {
          const text = flatten(m?.content ?? m?.message?.content)
          return { role: m?.role ?? m?.message?.role ?? '?', len: text.length, head: text.slice(0, 40) }
        })
        : []
      fs.mkdirSync(root, { recursive: true })
      fs.writeFileSync(debugFile, JSON.stringify({ at: new Date().toISOString(), keys, shapes, tail }, null, 2), 'utf8')
    } catch {}
  }
  const isSubagent = (payload) => {
    // 宿主 Session 上就带这两个字段：delegationDepth?: number、origin?: 'subagent'
    const depths = [
      payload?.agent?.session?.delegationDepth,
      payload?.session?.delegationDepth,
      payload?.agent?.session?.header?.delegationDepth,
      payload?.session?.header?.delegationDepth,
      payload?.agent?.header?.delegationDepth,
      payload?.delegationDepth,
    ]
    if (depths.some((v) => Number(v) > 0)) return true
    const origins = [
      payload?.agent?.session?.origin,
      payload?.session?.origin,
      payload?.agent?.session?.header?.origin,
      payload?.session?.header?.origin,
    ]
    if (origins.some((v) => String(v || '').toLowerCase() === 'subagent')) return true
    const kinds = [payload?.session?.kind, payload?.agent?.kind, payload?.agent?.session?.kind]
    if (kinds.some((v) => String(v || '').toLowerCase() === 'subagent')) return true
    if (payload?.agent?.subagent === true || payload?.session?.subagent === true) return true
    return false
  }

  // ── 2b. L0 采集：每步攒一行摘要，会话结束时落整段原文 ──────────────────
  const sRoot = service.store ?? { root };
  let lastCwd = ''
  // 取当前会话的工作目录：宿主把这件事放在 workingDirectory 服务里，字段名各版本不一，逐个试并记一次探针
  function cwdOf(agent) {
    const session = agent?.session
    const tries = [
      ['workingDirectory.get(session)', () => ctx.workingDirectory?.get?.(session)],
      ['workingDirectory.get(agent)', () => ctx.workingDirectory?.get?.(agent)],
      ['session.cwd', () => session?.cwd],
      ['session.workingDirectory', () => session?.workingDirectory],
      ['session.header.cwd', () => session?.header?.cwd],
    ]
    for (const [via, fn] of tries) {
      try {
        const v = fn()
        if (typeof v === 'string' && v.trim()) return { cwd: v, via }
      } catch { /* 换下一个 */ }
    }
    return { cwd: '', via: '' }
  }
  let logEvents = []
  let buf = { id: '', day: '', records: [], lastLine: '', wrote: false, dirty: false, lastWriteAt: 0 };
  let probeCount = 0;
  const markDirty = () => { buf.dirty = true };

  // 历史补扫：把宿主自己攒着的旧会话也搬进库（每次最多 15 个，跑完记一条 debug）
  /* ---------- 4E-2 蒸馏队列 ---------- */
  const storeRoot = typeof sRoot === 'string' ? sRoot : String(sRoot?.root || root)
  const queuePath = () => path.join(storeRoot, '_queue', 'distill.json')
  const readQueue = () => {
    try { return JSON.parse(fs.readFileSync(queuePath(), 'utf8'))?.items || [] } catch { return [] }
  }
  const writeQueue = (items) => {
    try {
      const p = queuePath()
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, JSON.stringify({ items: items.slice(-40) }, null, 2), 'utf8')
    } catch { /* 队列写失败不影响主流程 */ }
  }
  /* ---- 单轮队列（策划书 §25.6）：每回合只写一条记录，模型由 worker 在后台调 ---- */
  const turnsPath = () => path.join(storeRoot, '_queue', 'turns.json')
  const readTurns = () => {
    try { return JSON.parse(fs.readFileSync(turnsPath(), 'utf8'))?.items || [] } catch { return [] }
  }
  const writeTurns = (items) => {
    try {
      const p = turnsPath()
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, JSON.stringify({ version: 1, items: items.slice(-60) }, null, 2), 'utf8')
    } catch { /* 忽略 */ }
  }
  /** 入队一轮：同一会话同一 turn 只留最新一条 */
  const enqueueTurn = (id, day, { turn = 0, level = 'mid', user = '' } = {}) => {
    if (!id || !day) return
    const items = readTurns().filter((x) => !(x.id === id && x.turn === turn))
    items.push({
      id, day, turn, level,
      head: String(user || '').slice(0, 60),
      upTo: Number(turn) || 0,
      retry: 0,
      at: new Date().toISOString(),
    })
    writeTurns(items)
  }
  const enqueueDistill = (id, day) => {
    if (!id || !day) return
    const arch = path.join(storeRoot, '_sessions', day, id + '.distill.json')
    if (fs.existsSync(arch)) {
      // 蒸馏过：只有会话又长出 20% 以上才允许再蒸一次（老存档没记 bytes 的，放行一次）
      let prevBytes = 0
      try { prevBytes = Number(JSON.parse(fs.readFileSync(arch, 'utf8')).bytes || 0) } catch { prevBytes = 0 }
      let curBytes = 0
      try { curBytes = Number(readMeta(sRoot, { id, day })?.bytes || 0) } catch { curBytes = 0 }
      const grew = prevBytes === 0 ? true : curBytes > prevBytes * 1.2
      if (!grew) return
    }
    const items = readQueue()
    if (items.some((x) => x.id === id)) return
    items.push({ id, day, at: new Date().toISOString() })
    writeQueue(items)
  }
  const getLlm = () => (typeof ctx.get === 'function' ? ctx.get('llm') : ctx.llm)

  /** 定 provider/model：配置优先，否则从宿主已注册的 provider 里挑一个 deepseek 的 */
  const resolveLlmTarget = () => {
    const live = service.config() || {}
    const cp = String(live.llm?.provider || '')
    const cm = String(live.llm?.model || '')
    if (cp && cm) return { provider: cp, model: cm, from: 'config' }
    try {
      const llm = getLlm()
      const list = typeof llm?.listProviders === 'function' ? llm.listProviders() || [] : []
      const pick = list.find((x) => /deepseek/i.test(String(x?.id || x?.provider || x?.name || ''))) || list[0]
      const provider = pick?.id || pick?.provider || pick?.name || cp
      const models = pick?.models || pick?.modelList || []
      const model = pick?.defaultModel || (Array.isArray(models) ? (models[0]?.id || models[0] || '') : '') || cm
      return { provider: String(provider || ''), model: String(model || ''), from: 'listProviders', count: list.length }
    } catch (error) {
      return { provider: cp, model: cm, from: 'config', error: String(error?.message || error) }
    }
  }

  /** 调宿主模型；provider/model 定不下来就抛错（会进诊断，不会静默卡住） */
  const llmStream = (messages) => {
    const llm = getLlm()
    if (!llm || typeof llm.stream !== 'function') throw new Error('宿主没有提供 ctx.llm')
    const target = resolveLlmTarget()
    if (!target.provider || !target.model) {
      try { noteDebug({ root: storeRoot }, { type: 'distill/llm', shape: { ...target, message: '定不到 provider/model' } }) } catch { /* 忽略 */ }
      throw new Error('定不到模型（provider=' + (target.provider || '?') + ', model=' + (target.model || '?') + '）')
    }
    try { noteDebug({ root: storeRoot }, { type: 'distill/llm', shape: { provider: target.provider, model: target.model, from: target.from } }) } catch { /* 忽略 */ }
    void service.touchDiag?.('distill', { model: target.provider + '/' + target.model })
    return llm.stream({ provider: target.provider, model: target.model, messages })
  }
  /** 后台自动蒸：队列非空且 auto 才跑，12 秒去抖，同一时刻只跑一个 */
  let draining = false
  const kickDrain = () => {
    try { noteDebug({ root: storeRoot }, { type: 'distill/kick', shape: { queued: readQueue().length, turns: readTurns().length, draining } }) } catch { /* 忽略 */ }
    if (draining) return
    const live = service.config() || {}
    if (live.distill?.auto === false) return
    if (!readQueue().length && !readTurns().length) return
    draining = true
    setTimeout(async () => {
      try { await drainQueue({ limit: 2 }) } catch (error) { warn('自动蒸馏失败：' + (error?.message || error)) } finally { draining = false }
    }, 12000)
  }
  /** 消费单轮队列（策划书 §25.6）：一次一条，失败最多重试 3 次 */
  const drainTurns = async ({ limit = 1 } = {}) => {
    const out = { done: 0, written: 0, errors: [] }
    const items = readTurns()
    if (!items.length) return out
    const rank = { high: 3, mid: 2, low: 1 }
    const cand = [...items].sort((a, b) => (rank[b.level] || 0) - (rank[a.level] || 0))
    let n = 0
    for (const it of cand) {
      if (n >= limit) break
      n += 1
      const drop = () => writeTurns(readTurns().filter((x) => !(x.id === it.id && x.turn === it.turn)))
      let records = []
      try {
        const raw = readRaw(sRoot, { id: it.id, day: it.day })
        if (Array.isArray(raw)) records = raw
        else if (raw && Array.isArray(raw.records)) records = raw.records
      } catch { /* 原文读不到就用摘要兜底 */ }
      if (!records.length) {
        try { records = recordsFromSummary(readSummary(sRoot, { id: it.id, day: it.day }) || '') } catch { records = [] }
      }
      if (records.length < 2) { drop(); continue }
      let u = ''
      let a = ''
      for (let i = records.length - 1; i >= 0; i -= 1) {
        if (records[i].role === 'assistant' && !a) a = records[i].text
        if (records[i].role === 'user') { u = records[i].text; break }
      }
      if (!u) { drop(); continue }
      // 查重：跟库里已有条目太像就不调模型了（§26.4）
      try {
        const dcfg = (service.config() || {}).distill || {}
        const skipText = Number(dcfg.dedupeSkip ?? 0.7)
        const skipVec = Number(dcfg.dedupeSkipVector ?? 0.82)
        if (skipText > 0 || skipVec > 0) {
          const bm = await service.bestMatch(u)
          const best = bm.score
          const skipAt = bm.via === 'vector' ? skipVec : skipText
          // 第二条件：分数够之外，还要「同类型 / 共享 ≥2 关键词 / 同范围」才算重复（§26.4）
          if (skipAt > 0 && best >= skipAt && bm.dup) {
            drop()
            try { noteDebug({ root: storeRoot }, { type: 'distill/skip', shape: { id: it.id, turn: it.turn, best: Number(best.toFixed(3)), via: bm.via, hit: bm.id, why: bm.why } }) } catch { /* 忽略 */ }
            continue
          }
        }
      } catch { /* 查重失败就照常走 */ }
      try {
        const liveCfg = service.config() || {}
        const res = await distillOnce({
          call: llmStream,
          turn: { user: u, assistant: a },
          mode: 'turn',
          cfg: { ...(liveCfg.distill || {}), dumpDir: storeRoot },
          log: (m) => { try { noteDebug({ root: storeRoot }, { type: 'distill/turn', shape: { message: String(m).slice(0, 120) } }) } catch { /* 忽略 */ } },
        })
        const landed = service.landDistilled(res.entries, {
          mode: liveCfg.writeMode || 'semi',
          sessionId: it.id,
          source: 'turn',
          project: (() => { try { return String(readMeta(sRoot, { id: it.id, day: it.day })?.project || '') } catch { return '' } })(),
          turnRef: it.id + '#' + it.turn,
        })
        drop()
        out.done += 1
        out.written += Array.isArray(landed?.written) ? landed.written.length : 0
        try { noteDebug({ root: storeRoot }, { type: 'distill/turn/ok', shape: { id: it.id, turn: it.turn, written: out.written } }) } catch { /* 忽略 */ }
      } catch (error) {
        const bumped = readTurns().map((x) => (x.id === it.id && x.turn === it.turn ? { ...x, retry: (x.retry || 0) + 1 } : x))
        writeTurns(bumped.filter((x) => (x.retry || 0) < 3))
        out.errors.push({ id: it.id, turn: it.turn, error: String(error?.message || error) })
        try { service.touchDiag?.('distill', { error: String(error?.message || error).slice(0, 200) }) } catch { /* 忽略 */ }
      }
    }
    return out
  }

  /** 排干队列：串行、失败只记诊断，绝不抛给调用方 */
  const drainQueue = async ({ limit = 3 } = {}) => {
    // 先消费单轮（便宜、快），再蒸整段会话
    let turnOut = { done: 0, written: 0, errors: [] }
    try { turnOut = await drainTurns({ limit: 1 }) } catch { /* 单轮失败不影响整段蒸馏 */ }
    const items = readQueue()
    if (!items.length) return turnOut
    const live = service.config() || {}
    const mode = live.writeMode || 'semi'
    let done = 0
    let written = 0
    const errors = []
    for (const it of items.slice(0, Math.max(1, limit))) {
      let records = []
      try {
        records = readRaw(sRoot, { id: it.id, day: it.day }) || []
        if (!records.length) records = recordsFromSummary(readSummary(sRoot, { id: it.id, day: it.day }) || '')
      } catch (err) {
        errors.push({ id: it.id, error: '读不到会话：' + err.message })
        writeQueue(readQueue().filter((x) => x.id !== it.id))
        continue
      }
      if (records.length < 4) {
        writeQueue(readQueue().filter((x) => x.id !== it.id))
        continue
      }
      try {
        const out = await distillOnce({
          call: llmStream,
          records,
          cfg: { ...(live.distill || {}), dumpDir: storeRoot },
          log: (m) => log(String(m)),
        })
        const meta = readMeta(sRoot, { id: it.id, day: it.day }) || {}
        const landed = service.landDistilled(out.entries, { mode, sessionId: it.id, project: String(meta?.project || '') })
        let sceneWritten = []
        try {
          const sc = service.landScenes(out.scenes, {
            sessionId: it.id,
            day: it.day || dayOf(),
            project: meta.project || '',
            sources: landed.written.map((w) => w.id),
            started: meta.started || '',
            ended: meta.updated || meta.ended || '',
          })
          sceneWritten = sc.written || []
        } catch (err) {
          log('场景落盘失败：' + (err?.message || err))
        }
        let skillWritten = []
        try {
          const meta = readMeta(sRoot, { id: it.id, day: it.day }) || {}
          const sk = service.landSkills(out.skills, {
            mode,
            sessionId: it.id,
            project: meta.project || '',
          })
          skillWritten = sk.written || []
        } catch (err) {
          log('技能落盘失败：' + (err?.message || err))
        }
        try {
          const dir = path.join(storeRoot, '_sessions', it.day)
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(path.join(dir, it.id + '.distill.json'), JSON.stringify({
            at: new Date().toISOString(), session: it.id, attempts: out.attempts, mode,
            bytes: Number(meta?.bytes || 0),
            entries: out.entries, scenes: out.scenes, dropped: out.dropped, landed,
            scenesWritten: sceneWritten,
            skillsWritten: skillWritten,
          }, null, 2), 'utf8')
        } catch { /* 存档失败不影响落地 */ }
        written += landed.written.length
        done += 1
        log('蒸馏 ' + it.id.slice(0, 12) + '：条目 ' + landed.written.length + ' 条，场景 ' + sceneWritten.length + ' 个，技能 ' + skillWritten.length + ' 个')
      } catch (err) {
        errors.push({ id: it.id, error: String(err?.message || err) })
        log('蒸馏失败 ' + it.id.slice(0, 12) + '：' + (err?.message || err))
        try { service.touchDiag?.('distill', { error: String(err?.message || err).slice(0, 160) }) } catch { /* 忽略 */ }
      }
      writeQueue(readQueue().filter((x) => x.id !== it.id))
      await new Promise((r) => setTimeout(r, 40))
    }
    noteDebug({ root: storeRoot }, { type: 'distill/run', shape: { done, written, errors: errors.length } })
    return {
      done: done + turnOut.done,
      written: written + turnOut.written,
      errors: errors.concat(turnOut.errors),
      turns: turnOut.done,
      sessions: done,
    }
  }

  const SCAN_VERSION = 4
  const scanHistory = async ({ force = false, limit = 15 } = {}) => {
    if (!sessionCfg.enabled || sessionCfg.scanOnStart === false) return
    const { default: os } = await import('node:os')
    const { default: path } = await import('node:path')
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    let list = []
    try { list = listHostSessions(dshHome) } catch (err) { log('补扫失败：' + err.message); return }
    const have = new Set()
    try {
      for (const d of fs.readdirSync(sRoot, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        for (const f of fs.readdirSync(path.join(sRoot, d.name))) {
          if (f.endsWith('.meta.json')) have.add(f.replace(/\.meta\.json$/, ''))
        }
      }
    } catch { /* 目录还没有 */ }
    const todo = list.filter((s) => (force || !have.has(s.id)) && s.id !== buf.id).slice(0, Math.max(1, limit))
    if (!todo.length) return
    let ok = 0
    for (const s of todo) {
      try {
        const one = readHostSession(s.file, { isInjected: isInjectedText, max: 400 })
        if (!one.records.length) continue
        // 只有 1 个来回的历史会话基本都是子代理干活留下的，不补（§26.6）
        if (one.records.length < 4 && !force) continue
        const day = String(s.mtime).slice(0, 10)
        writeRaw(sRoot, { id: s.id, day, records: one.records })
        writeSummary(sRoot, { id: s.id, day, title: one.title, lines: pairLines(one.records) })
        writeMeta(sRoot, {
          id: s.id, day, title: one.title, started: day, ended: day,
          turns: Math.round(one.records.length / 2), project: '', status: 'raw',
          reason: 'history-scan', source: 'history-scan', bytes: s.bytes, compressed: 0,
        })
        ok += 1
      } catch (err) { log('补扫单个失败：' + err.message) }
      await new Promise((r) => setTimeout(r, 60))
    }
    noteDebug(sRoot, { type: 'history/scan', version: SCAN_VERSION, forced: force, shape: { found: list.length, scanned: todo.length, written: ok } })
    log('补扫历史会话：写入 ' + ok + ' 个（候选 ' + todo.length + '）')
  }
  const flushSession = (reason, logRecords = null, events = null) => {
    if (!buf.id || buf.records.length === 0) return;
    const nowMs = Date.now();
    // 每轮追加（v3）：只要有新内容就写，不再等 15 秒、也不再等攒够多少条
    const useLog = Array.isArray(logRecords) && logRecords.length > 0;
    const records = useLog ? logRecords : buf.records;
    const appendedBefore = Number(buf.appended || 0);
    const fresh = records.length > appendedBefore;
    if (!fresh && reason === 'session/flush') return;
    try {
      const titleOf = useLog
        ? (firstUser(logEvents, { isInjected: isInjectedText }) || buf.id).slice(0, 40)
        : (buf.records.find((r) => r.role === 'user')?.text || buf.id).slice(0, 40);
      // 只把这次新增的那几条压成一帧接到文件末尾：代价是 O(这一轮)，与会话多长无关
      let addedBytes = 0;
      let addedCompressed = 0;
      let addedCount = 0;
      if (fresh) {
        const ap = appendRaw(sRoot, { id: buf.id, day: buf.day }, records.slice(appendedBefore));
        addedCount = ap.added;
        addedBytes = ap.bytes;
        addedCompressed = ap.compressed;
        buf.appended = records.length;
        buf.bytes = Number(buf.bytes || 0) + addedBytes;
        buf.compressed = Number(buf.compressed || 0) + addedCompressed;
      }
      // 摘要与元信息不必每轮重写（它们只是索引），最多 5 秒一次
      const needMeta = fresh || reason !== 'session/flush';
      if (needMeta) {
        writeSummary(sRoot, { id: buf.id, day: buf.day, title: titleOf, lines: pairLines(records) });
        writeMeta(sRoot, {
          id: buf.id, day: buf.day, title: titleOf,
          started: buf.records.length ? buf.day : '', ended: dayOf(),
          turns: Math.round(records.length / 2), project: buf.cwd || lastCwd || '', status: 'raw',
          reason, source: useLog ? 'session-log' : 'buffer',
          attachments: (lastUserImages(events || []) || []).slice(0, 5),
          bytes: buf.bytes || addedBytes, compressed: buf.compressed || addedCompressed,
        });
        buf.metaAt = nowMs;
      }
      if (addedCount > 0) {
        log(`会话追加 ${buf.id}：+${addedCount} 条（共 ${records.length} 条 / ${Math.round((buf.bytes || 0) / 1024)} KB，${reason}）`);
      }
      buf.wrote = true;
      buf.dirty = false;
      buf.lastWriteAt = nowMs;
      // 落盘之后进蒸馏队列（auto 才自动跑；manual 完全不动）
      try {
        const liveNow = service.config() || {}
        if (liveNow.distill?.auto !== false && liveNow.writeMode !== 'manual') {
          // ① 单轮闸门（策划书 §25）：这一轮有没有可能定下了规则/约定
          if (liveNow.distill?.turnEnabled !== false && fresh) {
            try {
              let u = ''
              let a = ''
              for (let i = records.length - 1; i >= 0; i -= 1) {
                if (records[i].role === 'assistant' && !a) a = String(records[i].text || '')
                if (records[i].role === 'user') { u = String(records[i].text || ''); break }
              }
              const imgs = lastUserImages(events || [])
              const gate = worthAsking({ user: u, assistant: a, attachments: imgs.length })
              const coolMin = Number(liveNow.distill?.gateCooldownMin ?? 10)
              const cooled = coolMin > 0 && buf.lastGateAt && Date.now() - buf.lastGateAt < coolMin * 60000
              if (gate.hit && !cooled) {
                buf.lastGateAt = Date.now()
                buf.gateHit = true
                enqueueTurn(buf.id, buf.day, { turn: Math.round(records.length / 2), level: gate.level, user: u })
                try { noteDebug({ root: storeRoot }, { type: 'distill/gate', shape: { level: gate.level, reasons: gate.reasons.map((r) => r.why) } }) } catch { /* 忽略 */ }
                kickDrain()
              }
            } catch { /* 闸门失败不影响落盘 */ }
          }
          // ② 整段会话蒸馏（场景/技能要靠它）：不再按「≥16 条」，改成「这一场里出现过信号 + 至少 3 个来回」
          if (fresh && buf.gateHit && records.length >= 6) {
            enqueueDistill(buf.id, buf.day)
            kickDrain()
          }
        }
      } catch { /* 入队失败不影响落盘 */ }
    } catch (error) {
      warn(`会话落盘失败：${error?.message ?? error}`)
    }
  };

  const trackSession = (payload, user, assistant) => {
    // 存档路径也要挡子代理（§26.6）：pre-step 里挡的是「抓规则」，挡不住「落档」
    if (isSubagent(payload)) return;
    if (!buf.id) {
      buf.id = String(payload?.agent?.session?.id || payload?.session?.id || 'session-unknown');
      buf.day = dayOf();
      if (sessionCfg.enabled !== false) {
        noteDebug(sRoot, {
          type: 'session/start',
          shape: { id: buf.id, day: buf.day, hasSession: Boolean(payload?.agent?.session?.id) },
        });
      }
    }
    if (sessionCfg.enabled === false) return;
    const hasUser = Boolean(user && String(user).trim());
    if (hasUser) {
      buf.records.push({ role: 'user', text: user });
      appendSummary(sRoot, { id: buf.id, day: buf.day, title: buf.records[0].text.slice(0, 40) });
    }
    if (assistant && String(assistant).trim()) buf.records.push({ role: 'assistant', text: assistant });
    if (hasUser) markDirty();
    if (buf.records.length > 400) buf.records = buf.records.slice(-400);
    if (hasUser) {
      const line = summaryLine(user, assistant);
      if (line !== buf.lastLine) {
        buf.lastLine = line;
        appendSummary(sRoot, { id: buf.id, day: buf.day, line });
      }
    }
  };

  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const result = typeof next === 'function' ? await next() : undefined
      try {
        // 每步现读配置：面板里改「记多少」应该立刻生效，不能等重启
        const live = service.config() || cfg
        if (live.writeMode !== 'manual' && payload?.messages) {
          noteShape(payload)
          if (live.capture?.skipSubagents !== false && isSubagent(payload)) {
            return result
          }
          const { user, assistant } = lastPair(payload.messages)
          trackSession(payload, user, assistant)
          if (!buf.cwd) {
            // 取一次工作目录（宿主放在 workingDirectory 服务里，字段名各版本不一）
            const got = cwdOf(payload.agent)
            if (got.cwd) { buf.cwd = got.cwd; lastCwd = got.cwd }
            if (!buf.cwdProbed) {
              buf.cwdProbed = true
              noteDebug(sRoot, { type: 'cwd/probe', shape: { via: got.via, ok: Boolean(got.cwd) } })
            }
          }
          probeCount += 1
          if (probeCount <= 3 || probeCount % 20 === 0) {
            noteDebug(sRoot, {
              type: 'pre-step',
              shape: {
                n: probeCount,
                messages: payload.messages.length,
                turn: payload?.turn,
                step: payload?.step,
                userLen: String(user || '').length,
                asstLen: String(assistant || '').length,
              },
            })
          }
          const hash = `${user.length}:${assistant.length}:${user.slice(0, 120)}:${assistant.slice(0, 120)}`
          if (user && hash !== seen) {
            remember(hash)
            // 快速通道（§26.8）：只有「用户明确在定规矩」才当场按规则入库，不调模型。
            // 其它情况一律交给闸门 + 单轮提炼，避免两条路重复写。
            const fastOn = live.capture?.fastPath !== false
            if (fastOn && userGivesRule(user)) {

              const out = service.capture({ user, assistant, cwd: lastCwd || process.cwd(), source: 'auto' })
              if (out.written.length > 0) {
                log(`快速通道抓取 ${out.written.length} 条（跳过 ${out.dropped}）`)
              }
            }
          }
        }
      } catch (error) {
        warn(`抓取失败：${error?.message ?? error}`)
      }
      return result
    })
  } catch (error) {
    warn(`agent/pre-step 挂载失败：${error?.message ?? error}`)
  }

  // ── 2b-2. 冷会话兜底（§26.5）：凉了 ≥ coldAfterMin 且没蒸过的，启动时捡几条 ──
  // 不看轮数——一两轮就结束的会话也有人定过规矩，按「有没有蒸过 + 凉不凉」判。
  const coldSweep = () => {
    try {
      const mins = Number(sessionCfg.coldAfterMin ?? 30)
      const maxN = Number(sessionCfg.coldPerStart ?? 5)
      const minTurns = Number(sessionCfg.coldMinTurns ?? 3)
      if (!(mins > 0) || !(maxN > 0)) return []
      const now = Date.now()
      const queued = new Set(readTurns().map((x) => String(x.id || '')))
      const picked = pickColdSessions(listSessions(sRoot), {
        now,
        coldAfterMin: mins,
        max: maxN,
        minTurns,
        inQueue: (one) => queued.has(one.id) || one.id === buf.id,
        isDistilled: (one) => fs.existsSync(path.join(storeRoot, '_sessions', one.day, one.id + '.distill.json')),
        countTurns: (one) => {
          const recs = readRaw(sRoot, { id: one.id, day: one.day })
          return Array.isArray(recs) ? Math.round(recs.length / 2) : 0
        },
      })
      for (const one of picked) {
        enqueueTurn(one.id, one.day, { turn: one.turns, level: 'mid', user: '冷会话兜底' })
      }
      noteDebug(sRoot, { type: 'distill/cold', shape: { picked: picked.map((x) => x.id.slice(-8)), max: maxN, minTurns, coldAfterMin: mins } })
      if (picked.length) kickDrain()
      return picked
    } catch (error) {
      warn(`冷会话兜底失败：${error?.message ?? error}`)
      return []
    }
  }
  setTimeout(coldSweep, 8000)

  // ── 2c. 会话结束探针：三个候选事件各挂一个，看谁真的会触发 ───────────────
  for (const name of ['session/end-seed', 'session/disposed', 'session/flush', 'dispose']) {
    try {
      ctx.on(name, (payload) => {
        try {
          const extra = {};
          if (Array.isArray(payload?.log)) {
            const hist = {};
            for (const ev of payload.log) { const k = String(ev?.type || '?'); hist[k] = (hist[k] || 0) + 1; }
            extra.logTotal = payload.log.length;
            extra.logTypes = hist;
            const samples = payload.log.filter((ev) => /assistant|user/.test(String(ev?.type || ''))).slice(-2);
            extra.logSamples = samples.map((ev) => ({
              type: ev?.type,
              keys: ev?.data ? Object.keys(ev.data).slice(0, 8) : [],
              textLen: JSON.stringify(ev?.data || '').length,
              head: JSON.stringify(ev?.data?.message?.content?.[0]?.text || ev?.data?.content?.[0]?.text || '').slice(0, 60),
            }));
          }
          noteDebug(sRoot, { type: name, shape: shapeOf(payload, 1), ...extra });
          let extracted = null;
          if (Array.isArray(payload?.log)) {
            extracted = extractConversation(payload.log, { isInjected: isInjectedText });
            logEvents = payload.log;
          }
          flushSession(name, extracted, payload?.log || null);
        } catch (error) {
          warn(`探针 ${name} 出错：${error?.message ?? error}`)
        }
      });
    } catch (error) {
      warn(`挂 ${name} 失败：${error?.message ?? error}`)
    }
  }

  // ── 3. 四个工具 ────────────────────────────────────────────────────────
  const textOutput = (text) => ({
    schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
  })

  const tools = [
    {
      name: 'memory_search',
      description: '检索本地记忆库（BM25）。返回编号、类型、标题与正文，编号可用于 /memory 收下/丢弃。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '要查什么，中文自然语言或关键词' },
          limit: { type: 'integer', description: '最多几条，默认 5，最多 20' },
        },
        required: ['query'],
      },
      output: textOutput(),
      execute: async (args) => {
        const hits = await service.retrieve(String(args.query ?? ''), { cwd: process.cwd(), limit: Math.min(20, Number(args.limit) || 5), includeInactive: true })
        if (hits.length === 0) return { text: `没有查到与「${args.query}」相关的记忆。` }
        return { text: hits.map((h) => `[${h.id}] (${h.type}/${h.status}) ${h.title}\n${h.body}`).join('\n\n') }
      },
    },
    {
      name: 'memory_write',
      description: '把一条值得长期记住的事实/偏好/决策写进本地记忆库。默认进待确认箱，由用户收下。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: '一句话标题，40 字以内' },
          body: { type: 'string', description: '正文，300 字以内，写清结论与原因' },
          type: { type: 'string', enum: ['偏好', '项目', '事实', '决策', '知识', '教训'], description: '记忆类型' },
        },
        required: ['title', 'body'],
      },
      output: textOutput(),
      execute: (args) => {
        try {
          const entry = service.create({
            title: String(args.title ?? ''),
            body: String(args.body ?? ''),
            type: typeOf(args.type),
            status: 'pending',
          })
          return { text: `已记下 #${entry.id}（${entry.type}）${entry.title}，状态：${entry.status}。` }
        } catch (error) {
          return { text: `没有写入：${error?.message ?? error}` }
        }
      },
    },
    {
      name: 'memory_review',
      description: '查看或处理待确认箱：列出待确认条目，或按编号收下/丢弃。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['list', 'accept', 'discard'], description: 'list 列表 / accept 收下 / discard 丢弃' },
          id: { type: 'string', description: 'accept 或 discard 时的编号，如 41' },
        },
        required: ['action'],
      },
      output: textOutput(),
      execute: (args) => {
        const action = String(args.action ?? 'list')
        if (action === 'list') {
          const { entries } = service.list({ view: 'pending', limit: 50 })
          if (entries.length === 0) return { text: '待确认箱是空的。' }
          return { text: entries.map((e) => `[${e.id}] (${e.type}) ${e.title}\n${e.body}`).join('\n\n') }
        }
        const id = String(args.id ?? '')
        if (!id) return { text: '需要给一个编号。' }
        if (action === 'accept') {
          const entry = service.accept(id)
          return { text: `已收下 #${entry.id}` }
        }
        const out = service.discard(id)
        return { text: `已丢弃 #${out.id}（进 _trash，可恢复）` }
      },
    },
    {
      name: 'memory_stats',
      description: '本地记忆库概况：总条数、待确认、过期、冲突与仓库位置。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: textOutput(),
      execute: () => ({ text: memoryStatsLine(service) }),
    },
  ]

  for (const definition of tools) {
    try {
      const dispose = ctx.tools.register(definition)
      if (typeof ctx.on === 'function') ctx.on('dispose', () => { try { dispose?.() } catch {} })
    } catch (error) {
      warn(`工具 ${definition.name} 注册失败：${error?.message ?? error}`)
    }
  }

  // ── 4. /memory 命令 ────────────────────────────────────────────────────
  const commandHandler = async ({ rawInput, agent }) => {
    const text = String(rawInput ?? '').trim()
    if (!text || text === '帮助' || text === 'help') return { kind: 'success', text: HELP }
    const [sub, ...rest] = text.split(/\s+/)
    const arg = rest.join(' ').trim()
    try {
      if (sub === '状态') return { kind: 'success', text: memoryStatsLine(service) }
      if (sub === '搜索') {
        const hits = await service.retrieve(arg, { cwd: process.cwd(), limit: 5, includeInactive: true })
        if (hits.length === 0) return { kind: 'success', text: `没有查到「${arg}」。` }
        return { kind: 'success', text: hits.map((h) => `[${h.id}] (${h.type}) ${h.title}\n${h.body}`).join('\n\n') }
      }
      if (sub === '记下') {
        const [title, body] = arg.split(/[｜|]/).map((s) => (s ?? '').trim())
        if (!title) return { kind: 'error', text: '用法：/memory 记下 标题｜正文' }
        try {
          const entry = service.create({ title, body: body || title, status: 'pending' })
          return { kind: 'success', text: `已记下 #${entry.id}，待确认。用 /memory 收下 ${entry.id} 让它生效。` }
        } catch (error) {
          return { kind: 'error', text: `没有写入：${error?.message ?? error}` }
        }
      }
      if (sub === '收下') {
        const entry = service.accept(arg)
        return { kind: 'success', text: `已收下 #${entry.id} ${entry.title}` }
      }
      if (sub === '丢弃') {
        const out = service.discard(arg)
        return { kind: 'success', text: `已丢弃 #${out.id}（进 _trash）` }
      }
      if (sub === '重建') {
        const info = service.reindex()
        return { kind: 'success', text: `索引已重建：${info.docs} 条` }
      }
      if (sub === '口令') {
        const fresh = panel?.resetPassword?.()
        return { kind: 'success', text: fresh ? `面板口令已重置为：${fresh}\n（只显示这一次）` : '重置失败，看日志。' }
      }
      if (sub === '检查') {
        const r = service.maintain()
        return { kind: 'success', text: r.summary }
      }
      if (sub === '蒸馏') {
        const n = Math.max(1, Math.min(20, Number(String(arg || '').trim() || 3)))
        const q = await drainQueue({ limit: n })
        const r = service.maintain()
        const parts = []
        if (q.done) parts.push(`会话蒸馏 ${q.done} 个，落地 ${q.written} 条`)
        if (q.errors.length) parts.push(`会话蒸馏失败 ${q.errors.length} 个（${q.errors[0].error.slice(0, 40)}）`)
        if (r.distilled.length) parts.push(`日记蒸馏 ${r.distilled.length} 天：${r.distilled.map((d) => d.date).join('、')}`)
        return {
          kind: 'success',
          text: parts.length ? parts.join('；') + '。' : '没有需要蒸馏的会话或日记。',
        }
      }
      if (sub === '撤销') {
        const n = Math.max(1, Number(arg) || 1)
        const taken = service.undo(n)
        if (!taken.length) return { kind: 'success', text: '没有可撤回的自动写入。' }
        return {
          kind: 'success',
          text: `已撤回 ${taken.length} 条（进 _trash，可捞回）：\n${taken.map((t) => `#${t.id} ${t.title}`).join('\n')}`,
        }
      }
      if (sub === '归档') {
        const r = service.maintain()
        return {
          kind: 'success',
          text: r.archived
            ? `日记已归档：${r.archived.lines} 行 / ${r.archived.bytes} 字节 → _archive\\${r.archived.archive}${r.archived.id ? `，摘录是 #${r.archived.id}` : ''}`
            : '今天的日记还没到归档阈值（400 行或 32 KB）。',
        }
      }
      if (sub === '取代') {
        // 用法：/memory 取代 41 用 43   或   /memory 取代 41 用 43 原因
        const mm = String(arg || '').match(/^(\d{1,9})\s*用\s*(\d{1,9})\s*(.*)$/)
        if (!mm) return { kind: 'error', text: '用法：/memory 取代 41 用 43 [原因]' }
        const r = service.supersede(mm[1], { by: mm[2], reason: mm[3] })
        return { kind: 'success', text: `#${r.by} 现在顶替 #${r.old}（${r.reason}）。旧条留着可追溯，反悔就说「/memory 反悔取代 ${r.old}」。` }
      }
      if (sub === '反悔取代' || sub === '取消取代') {
        const id = String(arg || '').match(/\d{1,9}/)?.[0]
        if (!id) return { kind: 'error', text: '用法：/memory 反悔取代 41' }
        const r = service.unsupersede(id)
        return { kind: 'success', text: `#${r.id} 恢复成生效${r.other ? `，#${r.other} 那边的取代标记也清了` : ''}。` }
      }
      if (sub === '诊断') {
        const d = service.diag()
        const line = (label, at) => `${label}：${at || '（还没跑过）'}`
        const face = d.health === 'red' ? '红（有报错）' : d.health === 'amber' ? '黄（很久没抓到东西）' : '绿（正常）'
        return {
          kind: 'success',
          text: [
            `状态：${face}`,
            line('上次抓取', d.capture?.at),
            line('上次维护', d.maintain?.at),
            line('上次重建索引', d.reindex?.at),
            d.error && !d.error.seen ? `未读错误：${d.error.message || ''}` : '',
            `记忆 ${d.counts.total} 条：生效 ${d.counts.active}｜待确认 ${d.counts.pending}｜过期 ${d.counts.stale}`,
            d.library ? `五层：会话 ${d.library.sessions}｜场景 ${d.library.scenes}｜技能 ${d.library.skills}｜专题 ${d.library.pages}｜建议 ${d.library.suggestions}` : '',
            d.vector ? d.vector.text : '',
          ].filter(Boolean).join('\n'),
        }
      }
      if (sub === '补扫' || sub === '重扫') {
        const n = Math.max(1, Math.min(200, Number(String(rawInput).trim().split(/\s+/)[2] || 40)))
        await scanHistory({ force: sub === '重扫', limit: n })
        const done = listSessions(sRoot).length
        return { kind: 'success', text: `补扫跑完了：这次最多处理 ${n} 个，库里现在有 ${done} 个会话的摘要。\n再发一次可以继续补。` }
      }
      if (sub === '向量' || sub === '建向量') {
        const r = await service.embedAll()
        if (!r.ok) return { kind: 'error', text: `没建成：${r.reason}` }
        const vs = service.vectorStatus()
        return { kind: 'success', text: `向量已补齐 ${r.embedded} 条（共 ${r.total} 条）。${vs.text}` }
      }
      if (sub === '煮页' || sub === '煮') {
        if (!arg) return { kind: 'error', text: '用法：/memory 煮页 pnpm' }
        const page = await service.composeTopic({ topic: arg })
        if (!page) return { kind: 'error', text: `没找到跟「${arg}」有关的条目，先记几条再煮` }
        return {
          kind: 'success',
          text: [
            `煮好了：${page.title}（${page.slug}）`,
            `来源 ${page.sourceCount} 条，写在 pages/${page.slug}.md`,
            '',
            page.body.split('\n').slice(0, 14).join('\n'),
          ].join('\n'),
        }
      }
      if (sub === '技能' || sub === 'skill') {
        const name = rest.slice(1).join(' ').trim()
        if (!name) {
          const list = service.skills()
          if (!list.length) return { kind: 'success', text: '还没有技能卡。蒸馏时如果出现可复用的做法会自动写进来。' }
          return {
            kind: 'success',
            text: ['技能卡 ' + list.length + ' 张：', ...list.map((k) => '- ' + k.title + '（' + k.slug + '，' + (k.status === 'active' ? '生效' : '待确认') + '）')].join('\n'),
          }
        }
        const hit = service.skill(name) || service.skills().find((k) => k.title.indexOf(name) >= 0)
        if (!hit) return { kind: 'error', text: '没有找到技能：' + name }
        const full = service.skill(hit.slug)
        return {
          kind: 'success',
          text: ['# ' + full.title, '', '什么时候用：' + (full.when || '—'),
            '怎么做：', ...(full.how.length ? full.how.map((s) => '- ' + s) : ['- （没有）']),
            '坑：', ...(full.pitfalls.length ? full.pitfalls.map((s) => '- ' + s) : ['- （没有）']),
            '验证：' + (full.verify || '—'), '', '文件：' + full.file].join('\n'),
        }
      }
      if (sub === '建议' || sub === '画像建议') {
        const r = service.refreshSugg()
        const items = r.items || []
        if (!items.length) return { kind: 'success', text: '暂时没有画像建议。等库里攒够 2 条以上同类偏好在看。' }
        return {
          kind: 'success',
          text: ['画像建议 ' + items.length + ' 条（采纳才写进身份层）：',
            ...items.map((s) => '- ' + s.id + '  ' + (s.field === 'style' ? '说话风格' : '硬规则') + '：' + s.value + '  ← ' + s.reason),
            '', '用 /memory 采纳 ' + items[0].id + ' 或 /memory 忽略 ' + items[0].id].join('\n'),
        }
      }
      if (sub === '采纳' || sub === '忽略') {
        const id = rest.slice(1).join(' ').trim()
        if (!id) return { kind: 'error', text: '用法：/memory 采纳 sg-pnpm-yes（先 /memory 建议 看 id）' }
        if (sub === '采纳') {
          const r = service.acceptSuggestion(id)
          return { kind: 'success', text: '已采纳 ' + id + '。当前身份层：\n' + r.persona }
        }
        const r = service.dismissSuggestion(id)
        return { kind: 'success', text: '已忽略 ' + id + '（以后不再提；已累计忽略 ' + r.dismissed + ' 条）' }
      }
      if (sub === '专题') {
        const list = service.pages()
        if (!list.length) return { kind: 'success', text: '还没有专题。用 /memory 煮页 主题 煮一个。' }
        return {
          kind: 'success',
          text: [`专题 ${list.length} 个：`, ...list.map((p) => `- ${p.title}（${p.slug}，${p.sourceCount} 条来源，${p.updated}）`)].join('\n'),
        }
      }
      if (sub === '项目') {
        const list = service.projects()
        if (!list.length) return { kind: 'success', text: '还没有项目实体。在某个目录里记一条只属于该项目的记忆，就会自动建。' }
        return {
          kind: 'success',
          text: [`项目 ${list.length} 个：`, ...list.map((p) => `- ${p.name}（${p.id}）：${p.active} 条生效 / ${p.count} 条，路径 ${p.paths.join('、')}`)].join('\n'),
        }
      }
      if (sub === '打开') {
        const fixed = fixedPanelUrl()
        const current = panelUrl(ctx)
        const lines = []
        if (fixed) lines.push(`固定地址（书签用这个）：${fixed}`)
        if (current && current !== fixed) lines.push(`当前 DSH 端口地址：${current}`)
        if (!lines.length) {
          const port = ctx?.webServer?.port ?? ctx?.webApp?.port ?? ''
          lines.push(`面板地址：http://127.0.0.1:${port || '<DSH 端口>'}${BASE}/`)
        }
        lines.push('设置 › 面板 › 地址 里可以固定成 8787，之后地址不再变（改完要重启一次 DSH）。')
        return { kind: 'success', text: lines.join('\n') }
      }
      if (sub === '身份') return { kind: 'success', text: personaText(service) }
      if (sub === '我是' || sub === '我在' || sub === '我用' || sub === '我说话' || sub === '原则') {
        if (!arg) return { kind: 'error', text: '用法：/memory 我是 老王｜我在 深圳｜我用 中文｜我说话 直接｜原则 不确定就说不确定' }
        const patch = {}
        if (sub === '我是') patch.call = arg
        if (sub === '我在') patch.city = arg
        if (sub === '我用') patch.lang = arg
        if (sub === '我说话') patch.style = arg
        if (sub === '原则') {
          const p = service.persona()
          const list = Array.isArray(p.boundaries) ? p.boundaries.slice() : []
          if (!list.includes(arg)) list.push(arg)
          patch.boundaries = list.slice(0, 8)
        }
        service.setPersona(patch)
        return { kind: 'success', text: `记下了。\n\n${personaText(service)}` }
      }
      return { kind: 'error', text: `不认识的子命令「${sub}」。\n\n${HELP}` }
    } catch (error) {
      return { kind: 'error', text: `出错了：${error?.message ?? error}` }
    }
  }

  try {
    const dispose = ctx.commands.register({
      name: 'memory',
      description: '本地记忆库：状态 / 搜索 / 记下 / 收下 / 丢弃 / 检查 / 蒸馏 / 归档 / 取代 / 诊断 / 向量 / 撤销 / 建议 / 身份 / 我是 / 我在 / 我用 / 我说话 / 原则 / 重建 / 口令 / 打开',
      input: { hint: '状态｜搜索 词｜记下 标题｜正文｜收下 41｜丢弃 41｜检查｜蒸馏｜归档｜取代 41 用 43｜反悔取代 41｜诊断｜向量｜撤销 2｜建议｜采纳 sg-pnpm-yes｜忽略 sg-npm-no｜身份｜我是 老王｜我在 深圳｜我说话 直接｜原则 …｜重建｜口令｜打开' },
      handler: commandHandler,
    })
    if (typeof ctx.on === 'function') ctx.on('dispose', () => { try { dispose?.() } catch {} })
  } catch (error) {
    warn(`命令注册失败：${error?.message ?? error}`)
  }

  // ── 5. 面板（同端口，前缀 /dsh-memory） ────────────────────────────────
  let panel
  try {
    const portState = { fixedPort: 0, listening: false, error: '' }
    panel = createPanel({
      service,
      log,
      basePath: BASE,
      hooks: {
        distill: (opts) => drainQueue(opts),
        queueInfo: () => ({ queued: readQueue().length, dir: storeRoot }),
        portStatus: () => ({ ...portState }),
      },
      initialPassword: typeof rawConfig?.panel?.initialPassword === 'string' ? rawConfig.panel.initialPassword : '',
    })
    const handle = (req, res) => {
      try {
        if (!panel.handle(req, res)) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
          res.end('not found')
        }
      } catch (error) {
        warn(`面板出错：${error?.message ?? error}`)
        try { res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('internal error') } catch {}
      }
    }
    const dispose = ctx.webServer.register({ kind: 'prefix', path: BASE, handler: handle })
    if (typeof ctx.on === 'function') ctx.on('dispose', () => { try { dispose?.() } catch {} })
    log(`面板挂在 ${BASE}`)
    // 固定端口监听（panel.fixedPort > 0 才起）：给用户一个不随 DSH 端口变化的书签地址
    const fixedPort = Number(cfg.panel?.fixedPort || 0)
    if (Number.isFinite(fixedPort) && fixedPort > 0) {
      const server = http.createServer(handle)
      portState.fixedPort = fixedPort
      server.on('error', (e) => {
        portState.listening = false
        portState.error = e?.code === 'EADDRINUSE' ? '已被占用' : (e?.message ?? String(e))
        warn(`固定端口 ${fixedPort} 起不来：${portState.error}`)
      })
      server.listen(fixedPort, '127.0.0.1', () => {
        portState.listening = true
        portState.error = ''
        log(`面板固定地址：http://127.0.0.1:${fixedPort}${BASE}/`)
      })
      if (typeof ctx.on === 'function') ctx.on('dispose', () => { try { server.close() } catch {} })
    }
  } catch (error) {
    warn(`面板挂载失败：${error?.message ?? error}`)
  }

  function memoryStatsLine(svc) {
    const s = svc.stats()
    const extra = s.conflict > 0 ? `｜冲突 ${s.conflict}` : ''
    return `记忆 ${s.total} 条：生效 ${s.active}｜待确认 ${s.pending}｜过期 ${s.stale}${extra}｜今天日记 ${s.today} 条\n仓库：${s.root}`
  }

  function fixedPanelUrl() {
    const port = Number(cfg.panel?.fixedPort || 0)
    return Number.isFinite(port) && port > 0 ? `http://127.0.0.1:${port}${BASE}/` : ''
  }

  function panelUrl(context) {
    const fixed = fixedPanelUrl()
    if (fixed) return fixed
    try {
      const url = context.webApp?.getAdvertisedUrl?.()
      if (typeof url === 'string' && url) return new URL(BASE + '/', url).toString()
    } catch {}
    return ''
  }
}

export { loadConfig, saveConfig }
