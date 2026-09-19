// 自检：在不触碰真实数据的前提下，端到端验证「会话用量方框」的数据链路。
//
// 做法是把 ZCODE_HOME 指向临时目录，伪造一个最小化的 ZCode 会话库
// （session / model_usage 两张表）和一份客户端日志（里面有 session_data.acquire
// 行），再拉起服务实例，检查 /whale/session-usage.json 的输出是否符合口径：
// 分会话聚合、缓存命中不重复计价、输出不含 reasoning、已用上下文取最后一次输入、
// 以及「会话切换」能否被日志增量扫描捕捉到。
//
//   node tools/selftest.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { costOfCall, isPeak, USD_PRICES } from '../lib/pricing-usd.mjs'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-box-selftest-'))
const dbDir = path.join(tmpHome, 'cli', 'db')
const dataDir = path.join(tmpHome, 'whale')
const logDir = path.join(tmpHome, 'v2', 'logs')
fs.mkdirSync(dbDir, { recursive: true })
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })

const PORT = 39100 + Math.floor(Math.random() * 500)
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port: PORT }), 'utf8')

const dbFile = path.join(dbDir, 'db.sqlite')
const db = new DatabaseSync(dbFile)
db.exec(`
  CREATE TABLE session (
    id text primary key,
    title text not null
  );
  CREATE TABLE model_usage (
    id text primary key,
    session_id text not null,
    query_source text not null,
    input_tokens integer not null default 0,
    cache_read_input_tokens integer not null default 0,
    output_tokens integer not null default 0,
    reasoning_tokens integer not null default 0,
    started_at integer not null,
    completed_at integer
  );
`)

// 构造北京时间的时刻：hours 为北京时间小时
function bjMs(y, m, d, hours, minutes) {
  return Date.UTC(y, m - 1, d, hours - 8, minutes, 0)
}

// 2026-09-21 是周一；10:00 属高峰，13:00 属谷时，09-19 是周六（全谷）
const PEAK_AT = bjMs(2026, 9, 21, 10, 0)
const OFF_AT = bjMs(2026, 9, 21, 13, 0)
const WEEKEND_AT = bjMs(2026, 9, 19, 10, 0)

const SESSION_A = 'sess_aaaaaaa-0000-4000-8000-000000000001'
const SESSION_B = 'sess_bbbbbbb-0000-4000-8000-000000000002'

db.prepare('INSERT INTO session (id, title) VALUES (?, ?)').run(SESSION_A, '会话甲')
db.prepare('INSERT INTO session (id, title) VALUES (?, ?)').run(SESSION_B, '会话乙')

let muSeq = 0
function insertCall(sessionId, { input, cacheRead = 0, output = 0, at, querySource = 'main_turn' }) {
  muSeq += 1
  db.prepare(
    `INSERT INTO model_usage (id, session_id, query_source, input_tokens, cache_read_input_tokens,
      output_tokens, reasoning_tokens, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
  ).run('mu-' + muSeq, sessionId, querySource, input, cacheRead, output, at, at + 1000)
}

// 会话甲：一次高峰（10:00）+ 一次谷时（13:00，最后一次调用）；另有一条自动标题不该计入
insertCall(SESSION_A, { input: 500_000, cacheRead: 400_000, output: 5_000, at: PEAK_AT })
insertCall(SESSION_A, { input: 999_999, cacheRead: 999_999, output: 999_999, at: PEAK_AT + 60_000, querySource: 'session_title' })
insertCall(SESSION_A, { input: 123_456, cacheRead: 100_000, output: 3_000, at: OFF_AT })
// 会话乙：比甲更晚，用来验证「日志优先于数据库回退」
insertCall(SESSION_B, { input: 7_777_777, cacheRead: 7_000_000, output: 88_888, at: OFF_AT + 60_000 })

// 客户端日志：当前会话是甲
const logFile = path.join(logDir, '2026-09-21.log')
function appendAcquire(sessionId) {
  fs.appendFileSync(
    logFile,
    `[2026-09-21 10:00:00.000] [info] [pid:1] [renderer] v4 session data lease acquired ` +
      `{"event":"v4.session_data.acquire","sessionId":"${sessionId}","openKind":"cold"}\n`,
    'utf8'
  )
}
appendAcquire(SESSION_A)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log((ok ? '  ✅ ' : '  ❌ ') + name + (detail ? '  — ' + detail : ''))
}

// ---------- 纯函数：定价口径 ----------
{
  check(
    '峰谷判定符合北京时间规则',
    isPeak(PEAK_AT) === true && isPeak(OFF_AT) === false && isPeak(WEEKEND_AT) === false,
    `周一10点=${isPeak(PEAK_AT)} 周一13点=${isPeak(OFF_AT)} 周六10点=${isPeak(WEEKEND_AT)}`
  )

  // input 含缓存命中：100 万输入里 99.9 万命中，只有 1000 未命中
  const c = costOfCall({ input: 1_000_000, cacheRead: 999_000, output: 10_000 }, OFF_AT)
  const expect =
    (999_000 / 1e6) * USD_PRICES.off_peak.hit +
    (1_000 / 1e6) * USD_PRICES.off_peak.miss +
    (10_000 / 1e6) * USD_PRICES.off_peak.out
  const wrongIfDoubleCounted =
    (999_000 / 1e6) * USD_PRICES.off_peak.hit +
    (1_000_000 / 1e6) * USD_PRICES.off_peak.miss +
    (10_000 / 1e6) * USD_PRICES.off_peak.out
  check(
    '缓存命中不被按未命中价重复计费',
    Math.abs(c.cost - expect) < 1e-9,
    `期望 $${expect.toFixed(6)}，实际 $${c.cost.toFixed(6)}（若重复计费会得 $${wrongIfDoubleCounted.toFixed(6)}）`
  )
  check('拆分出的三分正确', c.hit === 999_000 && c.miss === 1_000 && c.out === 10_000, JSON.stringify({ hit: c.hit, miss: c.miss, out: c.out }))

  // output 已含 reasoning：多给 reasoning 不该改变金额
  const withReasoning = costOfCall({ input: 1000, cacheRead: 0, output: 10_000, reasoning: 999_999 }, OFF_AT)
  const withoutReasoning = costOfCall({ input: 1000, cacheRead: 0, output: 10_000 }, OFF_AT)
  check(
    '输出不含 reasoning（不重复计费）',
    Math.abs(withReasoning.cost - withoutReasoning.cost) < 1e-12,
    `$${withReasoning.cost.toFixed(6)} == $${withoutReasoning.cost.toFixed(6)}`
  )

  // 峰时单价是谷时两倍
  const peak = costOfCall({ input: 1_000_000, cacheRead: 0, output: 0 }, PEAK_AT)
  const off = costOfCall({ input: 1_000_000, cacheRead: 0, output: 0 }, OFF_AT)
  check('高峰单价为谷时两倍', Math.abs(peak.cost - off.cost * 2) < 1e-9, `$${peak.cost.toFixed(4)} vs $${off.cost.toFixed(4)}`)
}

// ---------- 服务端接口 ----------
async function getJson(port, pathname) {
  const res = await fetch('http://127.0.0.1:' + port + pathname, { signal: AbortSignal.timeout(3000) })
  return res.json()
}

async function waitReady(port, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const health = await getJson(port, '/whale/health')
      if (health && health.app === 'zcode-session-usage-box') return health
    } catch (err) {}
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'server.mjs')], {
  cwd: PLUGIN_ROOT,
  env: { ...process.env, ZCODE_HOME: tmpHome },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let childLog = ''
child.stdout.on('data', (c) => (childLog += c))
child.stderr.on('data', (c) => (childLog += c))

try {
  console.log('📊 会话用量方框自检（临时 ZCODE_HOME=' + tmpHome + '）\n')

  const health = await waitReady(PORT, 8000)
  check('服务在临时端口就绪', !!health, health ? 'port=' + health.port + ' pid=' + health.pid : childLog.slice(0, 200))
  if (!health) throw new Error('服务未就绪')
  const port = health.port

  // 页面与前端脚本可访问
  const pageRes = await fetch('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(3000) })
  const pageHtml = await pageRes.text()
  check('方框页面可访问且引用 box.js', pageRes.ok && pageHtml.includes('/whale/box.js'), 'HTTP ' + pageRes.status)
  const jsRes = await fetch('http://127.0.0.1:' + port + '/whale/box.js', { signal: AbortSignal.timeout(3000) })
  check('box.js 可访问', jsRes.ok, 'HTTP ' + jsRes.status)

  const s1 = await getJson(port, '/whale/session-usage.json')
  check('接口返回成功', !!s1.ok, JSON.stringify(s1).slice(0, 200))
  check('当前会话取自客户端日志（而非数据库回退）', s1.sessionSource === 'log', 'sessionSource=' + s1.sessionSource)
  check('会话标识与标题正确', s1.sessionId === SESSION_A && s1.title === '会话甲', JSON.stringify({ id: s1.sessionId, title: s1.title }))

  // 会话甲合计：只算 2 条 main_turn（自动标题那条要排除）
  const expHit = 400_000 + 100_000
  const expMiss = 100_000 + 23_456
  const expOut = 5_000 + 3_000
  check(
    '累计 token 三分正确且排除自动标题调用',
    s1.tokens.hit === expHit && s1.tokens.miss === expMiss && s1.tokens.out === expOut && s1.calls === 2,
    `hit=${s1.tokens.hit} miss=${s1.tokens.miss} out=${s1.tokens.out} calls=${s1.calls}`
  )
  check('累计 token 合计一致', s1.tokens.total === expHit + expMiss + expOut, 'total=' + s1.tokens.total)

  const expCost =
    (400_000 / 1e6) * USD_PRICES.peak.hit +
    (100_000 / 1e6) * USD_PRICES.peak.miss +
    (5_000 / 1e6) * USD_PRICES.peak.out +
    (100_000 / 1e6) * USD_PRICES.off_peak.hit +
    (23_456 / 1e6) * USD_PRICES.off_peak.miss +
    (3_000 / 1e6) * USD_PRICES.off_peak.out
  check(
    '累计花费按各次调用自己的时段分档',
    Math.abs(s1.cost.total - expCost) < 1e-9,
    `期望 $${expCost.toFixed(6)}，实际 $${s1.cost.total.toFixed(6)}`
  )
  check('标出高峰调用次数', s1.mix.peakCalls === 1, 'peakCalls=' + s1.mix.peakCalls)

  // 已用上下文 = 最后一次主请求的输入总量（含缓存命中）
  check('已用上下文取最后一次调用的输入', s1.context.used === 123_456, 'used=' + s1.context.used)
  check('上下文上限为一百万', s1.context.limit === 1_000_000, 'limit=' + s1.context.limit)
  check(
    '上下文百分比正确',
    Math.abs(s1.context.percent - 12.3456) < 1e-9,
    s1.context.percent + '%'
  )

  // 切换会话：往日志追加一条 acquire，服务应跟着切到乙
  appendAcquire(SESSION_B)
  let s2 = null
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400))
    s2 = await getJson(port, '/whale/session-usage.json')
    if (s2.sessionId === SESSION_B) break
  }
  check('切换会话后跟随改变（读日志增量）', !!s2 && s2.sessionId === SESSION_B, 'sessionId=' + (s2 && s2.sessionId))
  check('切到乙后数字换成乙的', !!s2 && s2.calls === 1 && s2.tokens.miss === 777_777, s2 ? `calls=${s2.calls} miss=${s2.tokens.miss}` : '')
  check('切到乙后上下文换成乙的', !!s2 && s2.context.used === 7_777_777, s2 ? 'used=' + s2.context.used : '')

  // 令牌关闭
  const info = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.json'), 'utf8'))
  const res = await fetch('http://127.0.0.1:' + port + '/whale/shutdown', {
    method: 'POST',
    headers: { 'x-whale-token': info.token },
    signal: AbortSignal.timeout(3000),
  })
  const stopped = await res.json()
  check('带令牌可以关闭服务', !!(stopped && stopped.ok), JSON.stringify(stopped))

  await new Promise((r) => setTimeout(r, 500))
  let alive = true
  try {
    await fetch('http://127.0.0.1:' + port + '/whale/health', { signal: AbortSignal.timeout(1000) })
  } catch (err) {
    alive = false
  }
  check('关闭后端口不再响应', !alive)
} catch (err) {
  check('自检过程未抛异常', false, String((err && err.message) || err) + (childLog ? ' | ' + childLog.slice(0, 300) : ''))
} finally {
  try {
    child.kill()
  } catch (err) {}
  try {
    db.close()
  } catch (err) {}
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch (err) {}
}

const failed = results.filter((r) => !r.ok)
console.log('\n' + (failed.length === 0 ? '全部通过（' + results.length + '/' + results.length + '）' : '失败 ' + failed.length + ' 项'))
process.exit(failed.length === 0 ? 0 : 1)
