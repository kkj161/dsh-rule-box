/**
 * dsh-rule-box —— 规则盒
 *
 * 一个装规矩的盒子。用户把一条规则（诉求）丢进来，每条规则各选一种生效方式：
 *   - global  全局：每次对话都注入进 systemPrompt，一直有效
 *   - summon  召唤：平时一个字都不注入；用户在消息里写「（命令 A）」才在当轮生效
 *
 * 三个半侧：
 *   - systemPrompt：① 常驻规则全文（函数式，设置页一关立刻消失）
 *                  ② 召唤命中：函数式，只有这一轮真的召唤了才有内容
 *   - session/event：监听 user/message，认出括号里写的是哪条命令，记在内存里
 *   - rules 工具 + /rule-box/api 设置页接口：用户用嘴说，或者去设置页点开关
 *
 * 规则存在插件目录的 rules.json（可用 config.stateFile 改），重启不丢。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-rule-box'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_STATE_FILE = join(HERE, '..', 'rules.json')

const GLOBAL_ORDER = 940
const SUMMON_ORDER = 941

/** 第一次装上时的种子规则：用户敲定的「先说后问」（模式 global）。 */
const SEED_RULES = [
  {
    id: 'r1',
    mode: 'global',
    name: '',
    enabled: true,
    text:
      '有事要做的时候：先回答问题（或说清对任务的理解），再说准备做什么（动哪些文件、跑什么命令、大概几步），' +
      '然后问一句「要不要开始」，等我同意再动手。\n' +
      '纯问答、没有动作可做的时候，只回答，不要提「准备做什么」，也不要问「开始吗」。\n' +
      '读、看、搜、查不算动作，直接做（读文件、翻代码、联网搜索、只读命令、查外部接口）。\n' +
      '写、改、建文件夹、下载、安装、发消息、删东西算动作，必须先问。\n' +
      '一次同意管完这件事，直到我下一条消息；中途为同一目标多做的（装依赖、删旧文件），做完说明额外动了什么。',
  },
]

let live = { rules: [], stateFile: DEFAULT_STATE_FILE, enabled: true }

/** 每个会话一条召唤状态：armed / conflict / released。只活在内存里，重启清空。 */
const SESSION_STATE = new Map()
const STATS = { userMessages: 0, summonHits: 0, conflicts: 0, injections: 0, lastError: '' }

/* ───────────────────────── 规则库 ───────────────────────── */

/** 名字/命令名统一收口：去掉包裹用的引号括号，压掉多余空白。 */
export function cleanName(value) {
  return String(value ?? '')
    .replace(/[「」『』【】\[\]"'“”‘’]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 比较用：连空格都不算，大小写也不分。 */
function nameKey(value) {
  return cleanName(value).replace(/\s+/g, '').toLowerCase()
}

/**
 * 把任意输入整理成合法的规则表。读文件、接 config、工具写回都走这里。
 * @param {unknown} raw
 * @returns {Array<{id:string,text:string,mode:'global'|'summon',name:string,enabled:boolean}>}
 */
export function normalizeRules(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const text = String(item.text ?? '').trim()
    if (!text) continue
    let id = String(item.id ?? '').trim()
    if (!id || seen.has(id)) {
      let n = out.length + 1
      while (seen.has(`r${n}`)) n += 1
      id = `r${n}`
    }
    seen.add(id)
    // 老版本写的是 trigger 模式，迁移成 summon
    const mode = item.mode === 'summon' || item.mode === 'trigger' ? 'summon' : 'global'
    out.push({
      id,
      text,
      mode,
      name: mode === 'summon' ? cleanName(item.name ?? item.trigger) : '',
      enabled: item.enabled !== false,
    })
  }
  return out
}

/**
 * 读规则表。config.rules 优先（测试/临时覆盖），否则读 stateFile；文件不存在就用种子规则并落盘。
 * @param {Record<string, unknown>} [config]
 */
export function loadRules(config = {}) {
  const stateFile = config && config.stateFile ? String(config.stateFile) : DEFAULT_STATE_FILE
  if (config && Array.isArray(config.rules)) {
    return { rules: normalizeRules(config.rules), stateFile }
  }
  if (existsSync(stateFile)) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
      const rules = Array.isArray(parsed) ? parsed : parsed?.rules
      return { rules: normalizeRules(rules), stateFile }
    } catch {
      // 文件坏了不炸宿主：从种子重来，坏文件改名留档
      try {
        renameSync(stateFile, `${stateFile}.broken`)
      } catch {
        /* 改名失败就算了 */
      }
    }
  }
  const rules = normalizeRules(SEED_RULES)
  saveRules(stateFile, rules)
  return { rules, stateFile }
}

/** 原子写：先写 .tmp 再 rename，别把规则表写成半截。 */
export function saveRules(stateFile, rules) {
  mkdirSync(dirname(stateFile), { recursive: true })
  const tmp = `${stateFile}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ version: 2, rules }, null, 2)}\n`, 'utf8')
  renameSync(tmp, stateFile)
}

function findRule(id) {
  return live.rules.find((r) => r.id === String(id ?? '').trim()) ?? null
}

/* ───────────────────────── 召唤解析 ───────────────────────── */

const SUMMARY_MAX = 46

/** 一行摘要：设置页和 list 里用，别把整条规则铺开。 */
export function summaryOf(text) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim()
  return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX)}…` : oneLine
}

/**
 * 把消息里所有括号片段捞出来（全角（）和半角()都认）。
 * @param {unknown} text
 * @returns {string[]}
 */
export function summonCandidates(text) {
  const out = []
  const source = String(text ?? '')
  const re = /[（(]([^（）()\n]{1,60})[）)]/g
  let m
  while ((m = re.exec(source)) !== null) {
    const raw = cleanName(m[1])
    if (raw) out.push(raw)
  }
  return out
}

/**
 * 括号里写的名字对上了哪几条召唤规则（同一个名字写两遍算一条）。
 * @param {Array} rules
 * @param {unknown} text
 * @returns {Array}
 */
export function resolveSummons(rules, text) {
  const list = normalizeRules(rules)
  const seen = new Set()
  const hit = []
  for (const word of summonCandidates(text)) {
    const key = nameKey(word)
    const rule = list.find((r) => r.enabled && r.mode === 'summon' && nameKey(r.name) === key)
    if (rule && !seen.has(rule.id)) {
      seen.add(rule.id)
      hit.push(rule)
    }
  }
  return hit
}

/* ───────────────────────── 会话状态 ───────────────────────── */

/** 从 session 对象上拿 id（宿主有 getId()，也有 header.id，两个都试）。 */
function sessionIdOfSession(session) {
  if (!session) return ''
  try {
    return String(session.id ?? session.header?.id ?? '')
  } catch {
    return ''
  }
}

/** 从 assemble 上下文里的 agent 拿 session id。 */
function sessionIdOfAgent(agent) {
  if (!agent) return ''
  try {
    return String(agent.session?.id ?? agent.session?.header?.id ?? '')
  } catch {
    return ''
  }
}

/** 用户消息内容 → 纯文本（content 是 [{type:'text',text}] 这种）。 */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part && part.type === 'text' ? String(part.text ?? '') : ''))
    .join('\n')
}

/**
 * 处理一条用户消息：召唤 / 解除 / 看不懂就当没发生。
 * 抽成导出函数，测试直接喂 sid + 文本。
 * @param {string} sid
 * @param {string} text
 */
export function recordUserText(sid, text) {
  const id = String(sid ?? '')
  const body = String(text ?? '')
  if (!id) return null
  const matched = resolveSummons(live.rules, body)
  const prev = SESSION_STATE.get(id)

  if (matched.length > 1) {
    STATS.conflicts += 1
    SESSION_STATE.set(id, { kind: 'conflict', names: matched.map((r) => r.name), ts: Date.now() })
    return SESSION_STATE.get(id)
  }

  if (matched.length === 1) {
    const rule = matched[0]
    STATS.summonHits += 1
    const replaced = prev && prev.kind === 'armed' && prev.ruleId !== rule.id ? prev.name : ''
    SESSION_STATE.set(id, { kind: 'armed', ruleId: rule.id, name: rule.name, replaced, ts: Date.now() })
    return SESSION_STATE.get(id)
  }

  if (prev && prev.kind === 'armed' && /解除/.test(body)) {
    SESSION_STATE.set(id, { kind: 'released', name: prev.name, ts: Date.now() })
    return SESSION_STATE.get(id)
  }

  // conflict / released 只活一轮：下一条用户消息来了就清掉
  if (prev && prev.kind !== 'armed') SESSION_STATE.delete(id)
  return SESSION_STATE.get(id) ?? null
}

/** 测试和调试用：读/清会话状态。 */
export function sessionState(sid) {
  return SESSION_STATE.get(String(sid ?? '')) ?? null
}

export function resetSessions() {
  SESSION_STATE.clear()
  STATS.userMessages = 0
  STATS.summonHits = 0
  STATS.conflicts = 0
  STATS.injections = 0
  STATS.lastError = ''
}

export function stats() {
  return { ...STATS, sessions: SESSION_STATE.size }
}

/* ───────────────────────── 注入 ───────────────────────── */

/** 全局规矩：关掉的不出现，一条都没有就返回空串。 */
export function renderGlobal(rules = []) {
  const globals = normalizeRules(rules).filter((r) => r.enabled && r.mode === 'global')
  if (!globals.length) return ''
  return [
    '【规则盒 · 常驻规矩】',
    '下面几条是用户定给你的规矩，跟当前任务是什么无关，一直有效，优先级高于你的默认习惯：',
    '',
    ...globals.map((r, i) => `${i + 1}. ${r.text}`),
  ].join('\n')
}

/** 召唤命中：规则全文 + 这一轮的收尾约定。 */
export function renderArmed(rule, state = {}) {
  if (!rule) return ''
  const lines = [
    `【规则盒 · 召唤命中】（${rule.name}）`,
    `用户这条消息里写了「（${rule.name}）」，这条规矩从现在起生效，直到这件事做完或者用户说解除：`,
    '',
    rule.text,
  ]
  if (state.replaced) lines.push('', `（上一条「${state.replaced}」已经被它顶掉了，不再执行。）`)
  lines.push(
    '',
    '执行要求：',
    `- 回复最后单独一行写：${rule.name} · 生效中`,
    `- 这件事做完后，在回复里提醒一句「（${rule.name}）可以解除了，说解除我就撤掉」。`,
    '- 没做完之前，后面每一条消息都继续按这条规矩做。',
  )
  return lines.join('\n')
}

/** 一条消息召唤了多条：都不执行，让用户重发。 */
export function renderConflict(names = []) {
  const list = names.filter(Boolean)
  if (!list.length) return ''
  return [
    '【规则盒 · 召唤冲突】',
    `用户这条消息里同时出现了多个命令：${list.map((n) => `「${n}」`).join('、')}。`,
    '规则盒一次只放一条进去，所以这条消息里哪条都别执行。',
    '先回用户一句：一次只能召唤一条命令，重新发一下要用的那条。不要猜她想用哪条，也不要解释原理。',
  ].join('\n')
}

/** 解除后那一轮，让模型确认一句就行。 */
export function renderReleased(name) {
  if (!name) return ''
  return [
    '【规则盒 · 已解除】',
    `用户说解除，「（${name}）」从这条消息起不再生效。`,
    '回复里确认一句就行，别再按它做，也别再提它的内容。',
  ].join('\n')
}

/** 组装时按 agent 的 session 找当前状态，决定这一节写什么。 */
function renderSummonSection(context) {
  try {
    const sid = sessionIdOfAgent(context?.agent)
    if (!sid) return ''
    const st = SESSION_STATE.get(sid)
    if (!st) return ''
    if (st.kind === 'armed') {
      const rule = findRule(st.ruleId)
      if (!rule || !rule.enabled) return ''
      STATS.injections += 1
      return renderArmed(rule, st)
    }
    if (st.kind === 'conflict') {
      STATS.injections += 1
      return renderConflict(st.names)
    }
    if (st.kind === 'released') {
      STATS.injections += 1
      return renderReleased(st.name)
    }
    return ''
  } catch (error) {
    STATS.lastError = String(error?.message ?? error)
    return ''
  }
}

/* ───────────────────────── 工具 ───────────────────────── */

const TOOL_DESCRIPTION = `规则盒：帮用户管理他自己定的规矩（规则），一条一条放进去，每条选一种生效方式。

两种模式：
- global（全局）：每次对话都生效的常驻规矩。
- summon（召唤）：平时不生效。用户在消息里写「（命令 A）」这样的括号命令时才在当轮生效，直到这件事做完或用户说解除。规则名字就是括号里那几个字。

什么时候用：
- 用户说「加规则」「记一条规矩」「以后都……」「这个当规则」→ action=add。
  · 用户说「全局 / 每次都要 / 默认」→ mode=global
  · 用户说「我写（命令 X）的时候才生效」→ mode=summon，name 必须填括号里那几个字；
    用户还没给名字就先问一句，别自己编。
- 用户问「现在有哪些规则」→ action=list；要改内容/改名字/关掉/再打开 → action=set；删掉 → action=remove。
- 用户说「删掉命令 B」「把命令 A 关掉」，直接调工具（这算管理动作，不用先问）。

铁律：
- 加新规则、改已有规则之前，先用一句话复述你的理解（名字 + 什么时候生效 + 具体要做什么），问用户「是不是这个意思」，得到确认再调 add / set。
- 规则文本照用户原意写准，可以补清楚「什么时候用、做什么、不算数的情况」，别加他没说过的要求。
- 召唤靠宿主自动识别括号，不需要你手动激活；被召唤的那一条会自己出现在上下文里。
- add / set / remove / 设置页开关都立即生效，不用重启。`

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'text'],
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
  },
}

function modeLabel(rule) {
  return rule.mode === 'global' ? '全局' : `召唤「${rule.name || '（空）'}」`
}

function renderList(rules) {
  if (!rules.length) return '规则盒是空的，还没有任何规则。'
  const lines = rules.map((r, i) => {
    const state = r.enabled ? '' : ' · 已关'
    return `${i + 1}. [${r.id}] ${modeLabel(r)}${state} — ${r.text}`
  })
  const g = rules.filter((r) => r.mode === 'global' && r.enabled).length
  const s = rules.filter((r) => r.mode === 'summon' && r.enabled).length
  return `${rules.length} 条规则（全局 ${g} · 召唤 ${s}）：\n${lines.join('\n')}`
}

/**
 * 规则盒工具。抽成独立函数，方便单测直接喂 args。
 * @param {Record<string, any>} args
 * @param {{rules: Array, stateFile: string}} state
 */
export function runTool(args = {}, state = live) {
  const action = String(args.action ?? 'list')
  const rules = normalizeRules(state.rules)
  const findIndex = (id) => rules.findIndex((r) => r.id === String(id ?? '').trim())

  if (action === 'list') {
    return { ok: true, text: renderList(rules) }
  }

  if (action === 'add') {
    const text = String(args.text ?? '').trim()
    if (!text) return { ok: false, text: 'add 需要 text（规则内容）。' }
    const mode = args.mode === 'summon' || args.mode === 'trigger' ? 'summon' : 'global'
    const ruleName = cleanName(args.name ?? args.trigger)
    if (mode === 'summon' && !ruleName) {
      return { ok: false, text: '召唤模式下必须给 name：用户写「（什么）」的时候才生效？没给就先问，别自己编。' }
    }
    if (mode === 'summon' && rules.some((r) => r.mode === 'summon' && nameKey(r.name) === nameKey(ruleName))) {
      return { ok: false, text: `「${ruleName}」这个名字已经有一条规则在用了，换一个名字，或者先用 set 改旧那条。` }
    }
    let n = rules.length + 1
    while (rules.some((r) => r.id === `r${n}`)) n += 1
    const rule = { id: `r${n}`, text, mode, name: mode === 'summon' ? ruleName : '', enabled: true }
    return commit(state, [...rules, rule], `加好了：[${rule.id}] ${modeLabel(rule)} — ${summaryOf(text)}`)
  }

  if (action === 'set') {
    const i = findIndex(args.id)
    if (i < 0) return { ok: false, text: `没有这条规则：${args.id}。先 list 看一眼 id。` }
    const next = [...rules]
    const r = { ...next[i] }
    if (args.text != null) {
      const t = String(args.text).trim()
      if (!t) return { ok: false, text: '规则内容不能改成空的。' }
      r.text = t
    }
    if (args.mode != null) {
      if (args.mode !== 'global' && args.mode !== 'summon' && args.mode !== 'trigger') {
        return { ok: false, text: 'mode 只能是 global 或 summon。' }
      }
      r.mode = args.mode === 'global' ? 'global' : 'summon'
      if (r.mode === 'global') r.name = ''
    }
    if (args.name != null || args.trigger != null) {
      if (r.mode === 'summon') {
        const wanted = cleanName(args.name ?? args.trigger)
        if (!wanted) return { ok: false, text: 'name 不能是空的。' }
        if (rules.some((x, j) => j !== i && x.mode === 'summon' && nameKey(x.name) === nameKey(wanted))) {
          return { ok: false, text: `「${wanted}」这个名字已经有一条规则在用了。` }
        }
        r.name = wanted
      }
    }
    if (r.mode === 'summon' && !r.name) {
      return { ok: false, text: '改成召唤模式时必须同时给 name。' }
    }
    if (args.enabled != null) r.enabled = args.enabled !== false
    next[i] = r
    return commit(state, next, `改好了：[${r.id}] ${modeLabel(r)}${r.enabled ? '' : ' · 已关'}`)
  }

  if (action === 'remove') {
    const id = String(args.id ?? '').trim()
    const hit = rules.find((r) => r.id === id || (args.text && r.text.includes(String(args.text))))
    if (!hit) return { ok: false, text: `没有这条规则：${id || args.text}。先 list 看一眼 id。` }
    return commit(state, rules.filter((r) => r !== hit), `删掉了：[${hit.id}] ${modeLabel(hit)} — ${summaryOf(hit.text)}`)
  }

  return { ok: false, text: `不认识的 action：${action}。能用的：add / list / set / remove。` }
}

/** 落盘 + 更新内存里的那份。 */
function commit(state, rules, message) {
  const next = normalizeRules(rules)
  state.rules = next
  if (state.stateFile) saveRules(state.stateFile, next)
  return { ok: true, text: message }
}

/* ───────────────────────── 设置页接口 ───────────────────────── */

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

function publicRules() {
  return live.rules.map((r) => ({
    id: r.id,
    name: r.name,
    mode: r.mode,
    text: r.text,
    enabled: r.enabled,
  }))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function handleApiRequest(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  if (req.method === 'GET' && (path === '/rule-box/api/rules' || path === '/rule-box/api/state')) {
    sendJson(res, 200, { ok: true, rules: publicRules() })
    return
  }

  if (req.method === 'GET' && path === '/rule-box/api/debug') {
    sendJson(res, 200, {
      ok: true,
      stats: stats(),
      rules: live.rules.length,
      hook: { sessionEvents: STATS.userMessages > 0 },
    })
    return
  }

  if (req.method === 'POST' && path === '/rule-box/api/toggle') {
    try {
      const body = await readBody(req)
      if (!body || typeof body !== 'object') {
        sendJson(res, 400, { ok: false, error: 'bad json' })
        return
      }
      const rule = findRule(body.id)
      if (!rule) {
        sendJson(res, 404, { ok: false, error: 'no such rule' })
        return
      }
      rule.enabled = body.enabled !== false
      saveRules(live.stateFile, live.rules)
      sendJson(res, 200, { ok: true, rules: publicRules() })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
    return
  }

  sendJson(res, 404, { ok: false, error: 'not found' })
}

/* ───────────────────────── 插件入口 ───────────────────────── */

export function apply(root, config = {}) {
  const loaded = loadRules(config)
  live = {
    rules: loaded.rules,
    stateFile: loaded.stateFile,
    enabled: config.enabled !== false,
  }
  SESSION_STATE.clear()
  STATS.userMessages = 0

  // ① 常驻规矩 + ② 召唤命中，两节都用函数式：设置页一关，下一次组装立刻消失
  root.inject(['systemPrompt'], (ctx) => {
    ctx.effect(() => {
      const offs = [
        ctx.systemPrompt.section({
          name: 'rule-box:global',
          order: GLOBAL_ORDER,
          text: () => (live.enabled ? renderGlobal(live.rules) : ''),
        }),
        ctx.systemPrompt.section({
          name: 'rule-box:summon',
          order: SUMMON_ORDER,
          text: (context) => (live.enabled ? renderSummonSection(context) : ''),
        }),
      ]
      return () => {
        for (const off of offs) {
          try {
            off()
          } catch {
            /* 已经卸了就算了 */
          }
        }
      }
    }, 'dsh-rule-box: 常驻规矩与召唤命中')
  })

  // 用户消息进来时认一下括号里的命令
  try {
    const offEvent = root.on('session/event', (session, event) => {
      try {
        if (!event || event.type !== 'user/message') return
        STATS.userMessages += 1
        const text = textOfContent(event.data?.content)
        if (!text) return
        recordUserText(sessionIdOfSession(session), text)
      } catch (error) {
        STATS.lastError = String(error?.message ?? error)
      }
    })
    root.effect(() => () => {
      try {
        offEvent?.()
      } catch {
        /* 忽略 */
      }
    }, 'dsh-rule-box: 召唤监听')
  } catch (error) {
    STATS.lastError = `session/event: ${String(error?.message ?? error)}`
  }

  // 设置页的数据来源
  root.inject(['webServer'], (ctx) => {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: '/rule-box/api',
          handler: async (req, res) => {
            try {
              await handleApiRequest(req, res)
            } catch (error) {
              sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      'dsh-rule-box: 设置页接口',
    )
  })

  root.inject(['tools'], (ctx) => {
    ctx.tools.register({
      name: 'rules',
      description: TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'list', 'set', 'remove'],
            description: 'add 加一条；list 看全部；set 改；remove 删。',
          },
          text: { type: 'string', description: '规则内容（add 必填；set 可用来改内容或按内容找规则）。' },
          mode: {
            type: 'string',
            enum: ['global', 'summon'],
            description: 'global = 每次对话都生效；summon = 用户写「（名字）」时才生效。',
          },
          name: {
            type: 'string',
            description: '召唤模式下括号里那几个字（如「命令 A」）；mode=summon 时必填。',
          },
          id: { type: 'string', description: '规则 id，如 r1（set / remove 用）。' },
          enabled: { type: 'boolean', description: 'set 时用来关掉或重新打开这条规则。' },
        },
        required: ['action'],
      },
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      execute: async (args) => runTool(args ?? {}, live),
    })
  })
}
