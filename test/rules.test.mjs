import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  apply,
  cleanName,
  loadRules,
  normalizeRules,
  recordUserText,
  renderArmed,
  renderConflict,
  renderGlobal,
  renderReleased,
  resetSessions,
  resolveSummons,
  runTool,
  saveRules,
  sessionState,
  stats,
  summonCandidates,
  summaryOf,
} from '../lib/index.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'rule-box-'))

/** 起一个假 root，把 section / tool / web 路由 / 事件都捞下来。 */
function fakeRoot() {
  const sections = []
  const tools = []
  const routes = []
  const listeners = []
  const root = {
    inject(names, fn) {
      fn({
        effect(factory) {
          const cleanup = factory()
          return () => cleanup?.()
        },
        systemPrompt: {
          section(s) {
            sections.push(s)
            return () => {
              const i = sections.indexOf(s)
              if (i >= 0) sections.splice(i, 1)
            }
          },
        },
        tools: {
          register(t) {
            tools.push(t)
          },
        },
        webServer: {
          register(route) {
            routes.push(route)
            return () => {
              const i = routes.indexOf(route)
              if (i >= 0) routes.splice(i, 1)
            }
          },
        },
      })
    },
    on(event, handler) {
      listeners.push({ event, handler })
      return () => {
        const i = listeners.findIndex((l) => l.handler === handler)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    effect(factory) {
      const cleanup = factory()
      return () => cleanup?.()
    },
  }
  return { root, sections, tools, routes, listeners }
}

const GLOBAL = { id: 'r1', mode: 'global', text: '先说准备做什么，再问要不要开始' }
const SUMMON = { id: 'r2', mode: 'summon', name: '命令 A', text: '回复里最多两段，不要列清单' }

function setup(config = {}) {
  const dir = tmp()
  resetSessions()
  const box = fakeRoot()
  apply(box.root, { stateFile: join(dir, 'rules.json'), rules: [GLOBAL, SUMMON], ...config })
  return { ...box, dir }
}

const section = (sections, name) => sections.find((s) => s.name === name)

function fakeRes() {
  const out = { status: 0, body: '' }
  return {
    out,
    writeHead(status) {
      out.status = status
    },
    end(text) {
      out.body = text
    },
  }
}

/* ───────────── 基础整理 ───────────── */

test('cleanName 去掉各种包裹引号和多余空白', () => {
  assert.equal(cleanName('「命令 A」'), '命令 A')
  assert.equal(cleanName('  『命令  B』 '), '命令 B')
  assert.equal(cleanName(null), '')
})

test('normalizeRules：迁移 trigger→summon、丢空文本、修重复 id', () => {
  const rules = normalizeRules([
    { id: 'a', mode: 'global', text: '一' },
    { id: 'a', mode: 'trigger', trigger: '「命令 B」', text: '二' },
    { id: 'c', mode: '???', text: '三' },
    { id: 'd', mode: 'global', text: '   ' },
    null,
  ])
  assert.equal(rules.length, 3)
  assert.equal(rules[0].id, 'a')
  assert.notEqual(rules[1].id, 'a')
  assert.equal(rules[1].mode, 'summon')
  assert.equal(rules[1].name, '命令 B')
  assert.equal(rules[2].mode, 'global')
})

test('summaryOf 压成一行并截断', () => {
  assert.equal(summaryOf('  一\n二\t三  '), '一 二 三')
  assert.equal(summaryOf('y'.repeat(100)).length, 47)
})

/* ───────────── 召唤词识别 ───────────── */

test('summonCandidates：全角半角括号都认，普通文字不认', () => {
  assert.deepEqual(summonCandidates('帮我看看（命令 A）这个'), ['命令 A'])
  assert.deepEqual(summonCandidates('用(命令 B)跑一下'), ['命令 B'])
  assert.deepEqual(summonCandidates('两个（命令 A）和（命令 C）'), ['命令 A', '命令 C'])
  assert.deepEqual(summonCandidates('没有括号的命令 A'), [])
  assert.deepEqual(summonCandidates(''), [])
})

test('resolveSummons：只命中开着的召唤规则，同名写两遍算一条', () => {
  const rules = normalizeRules([GLOBAL, SUMMON, { ...SUMMON, id: 'r3', name: '命令 B', enabled: false }])
  assert.equal(resolveSummons(rules, '（命令 A）').length, 1)
  assert.equal(resolveSummons(rules, '（命令 A）（命令 A）').length, 1)
  assert.equal(resolveSummons(rules, '（命令 B）').length, 0) // 关掉的不算
  assert.equal(resolveSummons(rules, '（命令 Z）').length, 0) // 不认识的不算
  assert.equal(resolveSummons(rules, '（命令 A）和（命令 B）').length, 1) // B 关着
})

/* ───────────── 会话状态机 ───────────── */

test('recordUserText：召唤、并存冲突、顶替、未知、解除', () => {
  const { dir } = setup()
  try {
    // 召唤 → armed
    recordUserText('s1', '先（命令 A）')
    assert.equal(sessionState('s1').kind, 'armed')
    assert.equal(sessionState('s1').ruleId, 'r2')

    // 未知命令：状态不变
    recordUserText('s1', '（命令 Z）')
    assert.equal(sessionState('s1').kind, 'armed')

    // 说解除 → released
    recordUserText('s1', '解除')
    assert.equal(sessionState('s1').kind, 'released')
    // 下一条普通消息把一次性提示清掉
    recordUserText('s1', '好的')
    assert.equal(sessionState('s1'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordUserText：一条消息两个不同命令 → 冲突，谁都不执行', () => {
  const { dir } = setup({ rules: [GLOBAL, SUMMON, { ...SUMMON, id: 'r3', name: '命令 B' }] })
  try {
    recordUserText('s2', '（命令 A）和（命令 B）都来')
    const st = sessionState('s2')
    assert.equal(st.kind, 'conflict')
    assert.deepEqual(st.names, ['命令 A', '命令 B'])
    assert.equal(stats().conflicts, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recordUserText：新的召唤顶掉旧的，记下被顶的是谁', () => {
  const { dir } = setup({ rules: [GLOBAL, SUMMON, { ...SUMMON, id: 'r3', name: '命令 B' }] })
  try {
    recordUserText('s3', '（命令 A）')
    recordUserText('s3', '改用（命令 B）')
    const st = sessionState('s3')
    assert.equal(st.ruleId, 'r3')
    assert.equal(st.replaced, '命令 A')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ───────────── 注入文本 ───────────── */

test('renderGlobal：只出开着的全局；没了就是空串', () => {
  assert.match(renderGlobal([GLOBAL, SUMMON]), /先说准备做什么/)
  assert.doesNotMatch(renderGlobal([GLOBAL, SUMMON]), /最多两段/)
  assert.equal(renderGlobal([{ ...GLOBAL, enabled: false }]), '')
  assert.equal(renderGlobal([]), '')
})

test('renderArmed：规则全文 + 状态行 + 解除提醒', () => {
  const text = renderArmed(normalizeRules([SUMMON])[0], { replaced: '命令 C' })
  assert.match(text, /不要列清单/)
  assert.match(text, /命令 A · 生效中/)
  assert.match(text, /可以解除了/)
  assert.match(text, /命令 C/)
})

test('renderConflict / renderReleased 说清楚该怎么回', () => {
  assert.match(renderConflict(['命令 A', '命令 B']), /一次只能召唤一条/)
  assert.match(renderReleased('命令 A'), /不再生效/)
})

/* ───────────── 落盘 ───────────── */

test('saveRules / loadRules 往返；文件丢了用种子；坏文件改名留档', () => {
  const dir = tmp()
  try {
    const file = join(dir, 'rules.json')
    saveRules(file, normalizeRules([GLOBAL, SUMMON]))
    const got = loadRules({ stateFile: file })
    assert.equal(got.rules.length, 2)
    assert.equal(got.rules[1].name, '命令 A')

    const missing = join(dir, 'nope.json')
    assert.equal(loadRules({ stateFile: missing }).rules.length, 1)
    assert.match(readFileSync(missing, 'utf8'), /先说|准备做什么/)

    writeFileSync(file, '{ 这不是 json', 'utf8')
    assert.equal(loadRules({ stateFile: file }).rules.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* ───────────── 工具 ───────────── */

test('add：全局直接进库；召唤缺名字、名字重复都要挡住', () => {
  const state = { rules: [], stateFile: join(tmp(), 'rules.json') }
  assert.equal(runTool({ action: 'add', text: GLOBAL.text, mode: 'global' }, state).ok, true)

  const noName = runTool({ action: 'add', text: '少用感叹号', mode: 'summon' }, state)
  assert.equal(noName.ok, false)
  assert.match(noName.text, /name/)

  const added = runTool({ action: 'add', text: '少用感叹号', mode: 'summon', name: '「命令 B」' }, state)
  assert.equal(added.ok, true)
  assert.equal(state.rules[1].name, '命令 B')

  const dup = runTool({ action: 'add', text: '另一条', mode: 'summon', name: '命令 B' }, state)
  assert.equal(dup.ok, false)
})

test('set：改模式、关掉、名字冲突、找不到 id', () => {
  const state = { rules: normalizeRules([GLOBAL, SUMMON]), stateFile: join(tmp(), 'rules.json') }
  assert.equal(runTool({ action: 'set', id: 'r2', mode: 'global' }, state).ok, true)
  assert.equal(state.rules[1].mode, 'global')
  assert.equal(state.rules[1].name, '')

  const noName = runTool({ action: 'set', id: 'r2', mode: 'summon' }, state)
  assert.equal(noName.ok, false)

  assert.equal(runTool({ action: 'set', id: 'r1', enabled: false }, state).ok, true)
  assert.equal(state.rules[0].enabled, false)

  assert.equal(runTool({ action: 'set', id: 'r9', mode: 'global' }, state).ok, false)
})

test('list / remove', () => {
  const state = { rules: normalizeRules([GLOBAL, SUMMON]), stateFile: join(tmp(), 'rules.json') }
  const listed = runTool({ action: 'list' }, state)
  assert.match(listed.text, /2 条规则/)
  assert.match(listed.text, /全局 1/)
  assert.match(listed.text, /召唤 1/)
  assert.match(listed.text, /命令 A/)

  assert.equal(runTool({ action: 'remove', id: 'r2' }, state).ok, true)
  assert.equal(state.rules.length, 1)
  assert.equal(runTool({ action: 'remove', id: 'r2' }, state).ok, false)
})

/* ───────────── 插件装配 ───────────── */

test('apply：注册两节函数式 prompt、tools、web 路由和 session 监听', () => {
  const { sections, tools, routes, listeners, dir } = setup()
  try {
    assert.deepEqual(
      sections.map((s) => s.name),
      ['rule-box:global', 'rule-box:summon'],
    )
    for (const s of sections) assert.equal(typeof s.text, 'function')
    assert.equal(tools[0].name, 'rules')
    assert.equal(routes[0].path, '/rule-box/api')
    assert.equal(listeners[0].event, 'session/event')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('不召唤时召唤那节是空的；召唤后按 session 出全文', () => {
  const { sections, dir } = setup()
  try {
    const summonSection = section(sections, 'rule-box:summon')
    assert.equal(summonSection.text({ agent: { session: { id: 's9' } } }), '')

    recordUserText('s9', '（命令 A）')
    const text = summonSection.text({ agent: { session: { id: 's9' } } })
    assert.match(text, /不要列清单/)
    assert.match(text, /命令 A · 生效中/)

    // 别的会话不受影响
    assert.equal(summonSection.text({ agent: { session: { id: 'other' } } }), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('session/event 里认出 user/message，喂给状态机', () => {
  const { listeners, sections, dir } = setup()
  try {
    const handler = listeners[0].handler
    handler(
      { id: 's10' },
      { type: 'user/message', data: { content: [{ type: 'text', text: '帮我（命令 A）' }] } },
    )
    assert.equal(sessionState('s10').kind, 'armed')
    assert.match(section(sections, 'rule-box:summon').text({ agent: { session: { id: 's10' } } }), /不要列清单/)

    // 非用户消息直接忽略
    handler({ id: 's11' }, { type: 'tool/result', data: {} })
    assert.equal(sessionState('s11'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('设置页接口：GET 列表、POST 开关，关掉后注入立刻消失', async () => {
  const { routes, sections, dir } = setup()
  try {
    const handler = routes[0].handler

    const getRes = fakeRes()
    await handler({ method: 'GET', url: '/rule-box/api/rules' }, getRes)
    assert.equal(getRes.out.status, 200)
    const listed = JSON.parse(getRes.out.body)
    assert.equal(listed.rules.length, 2)
    assert.equal(listed.rules[1].mode, 'summon')

    const body = JSON.stringify({ id: 'r1', enabled: false })
    const postRes = fakeRes()
    await handler(
      {
        method: 'POST',
        url: '/rule-box/api/toggle',
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(body)
        },
      },
      postRes,
    )
    assert.equal(postRes.out.status, 200)
    const after = JSON.parse(postRes.out.body)
    assert.equal(after.rules[0].enabled, false)

    // 全局那节立刻变空
    assert.equal(section(sections, 'rule-box:global').text(), '')

    const saved = JSON.parse(readFileSync(join(dir, 'rules.json'), 'utf8'))
    assert.equal(saved.rules[0].enabled, false)

    const missing = fakeRes()
    await handler({ method: 'POST', url: '/rule-box/api/toggle', async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify({ id: 'nope', enabled: true }))
    } }, missing)
    assert.equal(missing.out.status, 404)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
