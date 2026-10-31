/**
 * dsh-rule-box —— 浏览器半侧（DSH 设置页「规则盒」）
 * ----------------------------------------------------------------------------
 * 从 dsh.client bundle 加载（手写 ModuleLoader bundle，无需构建）：
 * 往 `settings.section` 注册一项，左边导航里就会出现「规则盒」。
 *
 * 数据不走 settings 命名空间，走 Host 半侧自带的 HTTP 接口（与 dsh-startup-screen 同款做法）：
 *   GET  /rule-box/api/rules   → { ok, rules: [{ id, name, mode, text, enabled }] }
 *   POST /rule-box/api/toggle  → { id, enabled } → { ok, rules }
 * 注释里的 id 必须等于 loader entry 名（dsh-rule-box），否则 ModuleLoader 会报
 * "loaded without registering dsh-rule-box"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-rule-box',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')
    var h = react.createElement

    var API = '/rule-box/api'

    /* ── CSS ─────────────────────────────────────────────────────────────── */
    var CSS = [
      '.__rb_root{max-width:720px;display:flex;flex-direction:column;gap:14px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.__rb_head{display:flex;flex-direction:column;gap:6px}',
      '.__rb_title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.__rb_help{font-size:12px;line-height:1.65;color:var(--dsw-alias-label-tertiary)}',
      '.__rb_list{display:flex;flex-direction:column;gap:10px}',
      '.__rb_row{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;display:flex;gap:12px;align-items:flex-start;justify-content:space-between}',
      '.__rb_main{display:flex;flex-direction:column;gap:6px;min-width:0;flex:1}',
      '.__rb_top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.__rb_name{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.__rb_badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.__rb_badgeOn{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}',
      '.__rb_text{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
      '.__rb_off{opacity:.55}',
      '.__rb_switch{flex:none;display:flex;align-items:center;gap:6px;cursor:pointer;font-size:11px;color:var(--dsw-alias-label-tertiary);padding-top:2px}',
      '.__rb_switch input{margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',
      '.__rb_empty{font-size:12px;color:var(--dsw-alias-label-tertiary);border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:18px;text-align:center}',
      '.__rb_foot{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.__rb_err{font-size:12px;color:var(--dsw-alias-state-error-primary,#f85149)}',
    ].join('')
    var tagId = 'dsh-rule-box/main.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + tagId + '"]') === null) {
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-rule-box'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function modeText(rule) {
      if (rule.mode === 'global') return '全局 · 每次对话都生效'
      return '召唤 · 写（' + (rule.name || '未命名') + '）时生效'
    }

    function Row(props) {
      var rule = props.rule
      var busy = props.busy === rule.id
      return h(
        'div',
        { className: '__rb_row' + (rule.enabled ? '' : ' __rb_off') },
        h(
          'div',
          { className: '__rb_main' },
          h(
            'div',
            { className: '__rb_top' },
            h('span', { className: '__rb_name' }, rule.name || '先说后问'),
            h('span', { className: '__rb_badge' }, modeText(rule)),
            h('span', { className: '__rb_badge' + (rule.enabled ? ' __rb_badgeOn' : '') }, rule.enabled ? '已开启' : '已关闭')
          ),
          h('div', { className: '__rb_text' }, rule.text)
        ),
        h(
          'label',
          { className: '__rb_switch', title: rule.enabled ? '关掉这条规则' : '重新开启这条规则' },
          h('input', {
            type: 'checkbox',
            checked: rule.enabled !== false,
            disabled: busy,
            onChange: function () {
              props.onToggle(rule, !rule.enabled)
            },
          }),
          busy ? '保存中' : rule.enabled ? '开' : '关'
        )
      )
    }

    function Panel() {
      var rules = react.useState(null)
      var list = rules[0]
      var setList = rules[1]
      var err = react.useState(null)
      var setErr = err[1]
      var busy = react.useState('')
      var setBusy = busy[1]
      var info = react.useState(null)
      var setInfo = info[1]

      function load() {
        fetch(API + '/rules')
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status)
            return res.json()
          })
          .then(function (data) {
            setList(data.rules || [])
            setErr(null)
          })
          .catch(function (error) {
            setErr(String((error && error.message) || error))
          })
        fetch(API + '/debug')
          .then(function (res) {
            return res.ok ? res.json() : null
          })
          .then(function (data) {
            setInfo(data)
          })
          .catch(function () {})
      }

      react.useEffect(function () {
        load()
      }, [])

      function toggle(rule, next) {
        setBusy(rule.id)
        fetch(API + '/toggle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: rule.id, enabled: next }),
        })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status)
            return res.json()
          })
          .then(function (data) {
            setList(data.rules || [])
            setErr(null)
          })
          .catch(function (error) {
            setErr(String((error && error.message) || error))
          })
          .then(function () {
            setBusy('')
          })
      }

      var body
      if (err[0]) {
        body = h('div', { className: '__rb_err' }, '读取规则失败：' + err[0])
      } else if (list === null) {
        body = h('div', { className: '__rb_empty' }, '读取中…')
      } else if (list.length === 0) {
        body = h('div', { className: '__rb_empty' }, '规则盒是空的。跟对话说「加规则：……，全局」或「加一条召唤规则，叫（命令 A）」就会出现在这里。')
      } else {
        body = h(
          'div',
          { className: '__rb_list' },
          list.map(function (rule) {
            return h(Row, { key: rule.id, rule: rule, busy: busy[0], onToggle: toggle })
          })
        )
      }

      var foot = null
      if (info[0] && info[0].stats) {
        var st = info[0].stats
        var line =
          '监听：收到 ' + st.userMessages + ' 条消息 · 召唤 ' + st.summonHits + ' 次 · 注入 ' + st.injections + ' 次'
        if (info[0].hook && info[0].hook.sessionEvents === false) line += '（还没收到消息，随便发一句试试）'
        foot = h('div', { className: '__rb_foot' }, line)
      }

      return h(
        'div',
        { className: '__rb_root' },
        h(
          'div',
          { className: '__rb_head' },
          h('div', { className: '__rb_title' }, '规则盒'),
          h(
            'div',
            { className: '__rb_help' },
            '关掉的规则不会进入提示词，下一次回复就生效。全局规则每次对话都带着；召唤规则平时不占地方，只有你写「（命令 A）」时才生效，直到那件事做完或者说「解除」。'
          )
        ),
        body,
        foot
      )
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          { name: 'settings.section', id: 'rule-box', order: 27, label: '规则盒' },
          function () {
            return h(Panel, {})
          }
        )
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
