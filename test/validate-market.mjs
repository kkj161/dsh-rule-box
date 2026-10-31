// 发布前自检：按 DSH 插件市场索引格式 1 的规则检查 market/index.json。
// 没有依赖，只用 node 内置模块。用法：node test/validate-market.mjs [index.json]
import { readFileSync, existsSync, statSync } from 'node:fs'
import { dirname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const file = resolve(process.argv[2] ?? resolve(here, '..', 'market', 'index.json'))

const errors = []
const fail = (path, message) => errors.push(`${path}: ${message}`)

const PACKAGE_NAME = /^(?:@[a-z0-9-*~][a-z0-9-*._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const PATH_SEGMENT = /^[A-Za-z0-9._@+-]+$/
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const DATA_ICON = /^data:image\/(?:svg\+xml|png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function checkLocalized(value, path) {
  if (typeof value === 'string') {
    if (value.trim() === '') fail(path, 'must not be empty')
    return
  }
  if (isObject(value)) {
    if (typeof value.en !== 'string' || value.en.trim() === '') fail(path, 'must contain a non-empty "en" string')
    for (const [lang, text] of Object.entries(value)) {
      if (typeof text !== 'string') fail(`${path}.${lang}`, 'must be a string')
    }
    return
  }
  fail(path, 'must be a string or an object keyed by language id')
}

function checkHttpUrl(value, path, protocols) {
  if (typeof value !== 'string') return fail(path, 'must be a string URL')
  let url
  try {
    url = new URL(value)
  } catch {
    return fail(path, 'must be an absolute URL')
  }
  if (!protocols.includes(url.protocol)) fail(path, `must use ${protocols.join(' or ')}`)
  if (url.username !== '' || url.password !== '') fail(path, 'must not contain credentials')
  if (url.href.includes('?') || url.href.includes('#')) fail(path, 'must not contain a query or fragment')
}

function checkIcon(value, path) {
  if (typeof value !== 'string') return fail(path, 'must be a string')
  if (value.startsWith('data:')) {
    const m = DATA_ICON.exec(value)
    if (!m) return fail(path, 'must be a base64 SVG, PNG, JPEG, or WebP data URL')
    const payload = m[1]
    if (!BASE64.test(payload)) return fail(path, 'must be base64')
    const bytes = (payload.length / 4) * 3 - (payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0)
    if (bytes > 32768) fail(path, 'must not exceed 32 KiB of decoded bytes')
    return
  }
  let resolved
  try {
    resolved = new URL(value, pathToFileURL(file))
  } catch {
    return fail(path, 'must be a URL reference')
  }
  if (resolved.protocol !== 'https:' && resolved.protocol !== 'file:') {
    fail(path, 'must resolve to https or a file next to the index')
    return
  }
  if (resolved.protocol === 'file:') {
    const local = fileURLToPath(resolved)
    if (!existsSync(local)) fail(path, `icon file not found: ${local}`)
    else if (statSync(local).size > 32768) fail(path, 'icon file must not exceed 32 KiB')
  }
}

function checkSource(value, path) {
  if (!isObject(value)) return fail(path, 'must be an object')
  if (value.type === 'npm') {
    if (value.registry !== undefined) checkHttpUrl(value.registry, `${path}.registry`, ['https:', 'http:'])
    return
  }
  if (value.type === 'git') {
    checkHttpUrl(value.url, `${path}.url`, ['https:'])
    if (typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/.test(value.commit)) {
      fail(`${path}.commit`, 'must be a lowercase 40-hex-digit commit SHA')
    }
    if (value.path !== undefined) {
      if (typeof value.path !== 'string' || value.path.split('/').some((s) => s === '' || s === '.' || s === '..' || !PATH_SEGMENT.test(s))) {
        fail(`${path}.path`, 'must be a relative directory of letters, digits, and ._@+- segments without . or ..')
      }
    }
    return
  }
  fail(`${path}.type`, 'must be "npm" or "git"')
}

function checkRange(value, path) {
  if (typeof value !== 'string' || value.trim() === '') return fail(path, 'must be a SemVer range string')
  if (value.startsWith('workspace:')) return fail(path, 'must not be a workspace: range')
  const parts = value.split('||').map((s) => s.trim())
  for (const part of parts) {
    const tokens = part.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return fail(path, 'must be a SemVer range string')
    for (const token of tokens) {
      const m = /^(?:>=|<=|>|<|=|\^|~)?\s*v?(\d+(?:\.\d+){0,2})(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(token)
      if (!m) return fail(path, `not understood as a SemVer range: ${JSON.stringify(token)}`)
    }
  }
}

function checkVersion(value, path, seen) {
  if (!isObject(value)) return fail(path, 'must be an object')
  if (typeof value.version !== 'string' || !SEMVER.test(value.version)) {
    fail(`${path}.version`, 'must be an exact SemVer version')
  } else if (seen.has(value.version)) {
    fail(`${path}.version`, `duplicates ${value.version}`)
  } else {
    seen.add(value.version)
  }
  if (
    typeof value.publishTimestamp !== 'number' ||
    !Number.isInteger(value.publishTimestamp) ||
    value.publishTimestamp < 0 ||
    value.publishTimestamp >= 1e11
  ) {
    fail(`${path}.publishTimestamp`, 'must be an integer number of Unix seconds in [0, 10^11)')
  }
  checkSource(value.source, `${path}.source`)
  if (value.engines !== undefined) {
    if (!isObject(value.engines)) fail(`${path}.engines`, 'must be an object')
    else if (value.engines.dsh !== undefined) checkRange(value.engines.dsh, `${path}.engines.dsh`)
  }
}

console.log('checking', file)
const text = readFileSync(file, 'utf8')
let index
try {
  index = JSON.parse(text)
} catch (error) {
  console.error('FAIL: not valid JSON —', error.message)
  process.exit(1)
}

const declared = { categories: new Set(), labels: new Set(), sortKeys: new Set() }
if (!isObject(index)) fail('$', 'must be an object')
else {
  if (index.format !== 1) fail('$.format', 'must be the number 1')
  checkLocalized(index.title, '$.title')
  if (index.description !== undefined) checkLocalized(index.description, '$.description')
  if (index.metadata !== undefined) {
    if (!isObject(index.metadata)) fail('$.metadata', 'must be an object')
    else {
      for (const group of ['categories', 'labels', 'sortKeys']) {
        const value = index.metadata[group]
        if (value === undefined) continue
        if (!isObject(value)) {
          fail(`$.metadata.${group}`, 'must be an object')
          continue
        }
        for (const [id, decl] of Object.entries(value)) {
          if (!isObject(decl)) {
            fail(`$.metadata.${group}.${id}`, 'must be an object')
            continue
          }
          checkLocalized(decl.title, `$.metadata.${group}.${id}.title`)
          if (group === 'sortKeys' && decl.order !== 'asc' && decl.order !== 'desc') {
            fail(`$.metadata.${group}.${id}.order`, 'must be "asc" or "desc"')
          }
          declared[group].add(id)
        }
      }
    }
  }

  if (!Array.isArray(index.plugins) || index.plugins.length === 0) {
    fail('$.plugins', 'must be a non-empty array')
  } else {
    const names = new Set()
    index.plugins.forEach((plugin, i) => {
      const at = `$.plugins[${i}]`
      if (!isObject(plugin)) return fail(at, 'must be an object')
      if (typeof plugin.name !== 'string' || !PACKAGE_NAME.test(plugin.name) || plugin.name.length > 214) {
        fail(`${at}.name`, 'must be a valid npm package name')
      } else if (names.has(plugin.name)) {
        fail(`${at}.name`, `duplicates ${plugin.name}`)
      } else {
        names.add(plugin.name)
      }
      for (const field of ['title', 'description']) {
        if (plugin[field] !== undefined) checkLocalized(plugin[field], `${at}.${field}`)
      }
      if (plugin.icon !== undefined) checkIcon(plugin.icon, `${at}.icon`)
      if (plugin.author !== undefined && typeof plugin.author !== 'string') fail(`${at}.author`, 'must be a string')
      if (plugin.homepage !== undefined) checkHttpUrl(plugin.homepage, `${at}.homepage`, ['https:', 'http:'])
      if (plugin.repository !== undefined) {
        if (!isObject(plugin.repository)) fail(`${at}.repository`, 'must be an object')
        else {
          checkHttpUrl(plugin.repository.url, `${at}.repository.url`, ['https:', 'http:'])
          if (plugin.repository.directory !== undefined) {
            if (typeof plugin.repository.directory !== 'string') fail(`${at}.repository.directory`, 'must be a string')
          }
        }
      }
      const meta = plugin.metadata
      if (meta !== undefined) {
        if (!isObject(meta)) fail(`${at}.metadata`, 'must be an object')
        else {
          if (meta.category !== undefined && !declared.categories.has(meta.category)) {
            fail(`${at}.metadata.category`, `references undeclared id ${JSON.stringify(meta.category)}`)
          }
          for (const field of ['labels']) {
            if (meta[field] === undefined) continue
            if (!Array.isArray(meta[field])) {
              fail(`${at}.metadata.${field}`, 'must be an array')
              continue
            }
            const used = new Set()
            meta[field].forEach((id, k) => {
              if (!declared[field].has(id)) fail(`${at}.metadata.${field}[${k}]`, `references undeclared id ${JSON.stringify(id)}`)
              if (used.has(id)) fail(`${at}.metadata.${field}`, 'must not repeat an id')
              used.add(id)
            })
          }
          if (meta.sortKeys !== undefined) {
            if (!isObject(meta.sortKeys)) fail(`${at}.metadata.sortKeys`, 'must be an object')
            else {
              for (const [id, value] of Object.entries(meta.sortKeys)) {
                if (!declared.sortKeys.has(id)) fail(`${at}.metadata.sortKeys.${id}`, 'references an undeclared sort key')
                if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${at}.metadata.sortKeys.${id}`, 'must be a finite number')
              }
            }
          }
        }
      }
      if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) {
        fail(`${at}.versions`, 'must be a non-empty array')
      } else {
        const seen = new Set()
        plugin.versions.forEach((v, k) => checkVersion(v, `${at}.versions[${k}]`, seen))
      }
    })
  }
}

if (errors.length > 0) {
  console.error(`FAIL — ${errors.length} problem(s):`)
  for (const line of errors) console.error('  ' + line)
  process.exit(1)
}

const count = index.plugins.length
console.log(`PASS — ${count} plugin(s), ${index.plugins.reduce((n, p) => n + p.versions.length, 0)} version(s)`)
