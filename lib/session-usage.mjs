// 会话用量：确定「当前正在看的会话」，再聚合该会话自新建以来的累计用量。
//
// 三个数字：累计 token（缓存命中/未命中/输出三分）、累计花费、已用上下文。
//
// 怎么知道当前是哪个会话：ZCode 插件拿不到 UI 事件，但客户端每次从会话列表
// 打开一个会话，都会往 <dataBaseDir>/.zcode/v2/logs/<日期>.log 写一行
// v4.session_data.acquire（带 sessionId），这是唯一能反映「用户正在看哪个
// 会话」的可读信号。日志里读不到时才回退到「最近有调用的会话」。
//
// 日志用增量扫描而不是只读尾部：客户端每分钟都会写内存采样等噪音行，一次
// acquire 几百 KB 后就会被挤出尾部窗口（实测切完半小时就落到 35 万字节之外），
// 只读尾部必然读不到。这里记住上次读到的偏移，每次只读新增部分。
//
// 为什么不用按日期拼日志文件名：客户端按本地日期命名，若用 UTC 日期去拼，
// 北京时间 00:00–08:00 之间会拼成前一天、读不到文件。这里直接取目录里最新的。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { CLIENT_LOG_DIR, DB_FILE, ZCODE_HOME } from './paths.mjs'
import { costOfCall } from './pricing-usd.mjs'

const require = createRequire(import.meta.url)

// 上下文分母：与 ZCode 给 deepseek 系列配置的 contextWindow 一致
export const CONTEXT_LIMIT = 1000000

// 建立基线时最多回看多少字节；超出则放弃日志、回退数据库
const FIRST_SCAN_BYTES = 8 * 1024 * 1024
// 未成行残片的上限，超出即丢弃，避免异常长行撑爆内存
const PENDING_MAX = 64 * 1024

let sqliteModule = null
let sqliteProbed = false

function loadSqlite() {
  if (sqliteProbed) return sqliteModule
  sqliteProbed = true
  try {
    // node:sqlite 自 Node 22.5 起内置；拿不到就没有数据源
    sqliteModule = require('node:sqlite')
  } catch (err) {
    sqliteModule = null
  }
  return sqliteModule
}

// ---------- 当前会话：增量扫描客户端日志 ----------

function candidateLogDirs() {
  const dirs = []
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ZCODE_HOME, 'v2', 'setting.json'), 'utf8'))
    const base = typeof cfg.dataBaseDir === 'string' ? cfg.dataBaseDir.trim() : ''
    // dataBaseDir 指的是「ZCode 的根目录」，客户端数据在其下的 .zcode/v2
    if (base) dirs.push(path.join(base, '.zcode', 'v2', 'logs'))
  } catch (err) {}
  dirs.push(CLIENT_LOG_DIR)
  return dirs
}

function newestLogFile() {
  let best = null
  for (const dir of candidateLogDirs()) {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      continue
    }
    for (const e of entries) {
      if (!e.isFile() || !/\.log$/i.test(e.name)) continue
      const full = path.join(dir, e.name)
      let mtime = 0
      try {
        mtime = fs.statSync(full).mtimeMs
      } catch (err) {
        continue
      }
      if (!best || mtime > best.mtime) best = { full, mtime }
    }
  }
  return best ? best.full : null
}

function readRange(file, start, end) {
  const fd = fs.openSync(file, 'r')
  try {
    const len = Math.max(0, end - start)
    const buf = Buffer.alloc(len)
    if (len > 0) fs.readSync(fd, buf, 0, len, start)
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

function extractSessionId(line) {
  if (!line.includes('session_data.acquire') && !line.includes('conversation.subscribe.activated')) {
    return ''
  }
  // acquire 行带 sessionId；subscribe.activated 只有 topic，从 topic 里取
  const m = /"sessionId":"([^"]+)"/.exec(line) || /"topic":"conversation\/([^"]+)"/.exec(line)
  return m && m[1] ? m[1] : ''
}

let logState = { file: null, offset: 0, pending: '', sessionId: '' }

// 返回日志里最近一次打开的会话 id；读不到返回 null
export function activeSessionFromLog() {
  const file = newestLogFile()
  if (!file) return logState.sessionId || null

  let st
  try {
    st = fs.statSync(file)
  } catch (err) {
    return logState.sessionId || null
  }

  let fromMiddle = false
  // 换文件（跨天）或被截断 → 重新建立基线
  if (logState.file !== file || st.size < logState.offset) {
    logState.file = file
    logState.pending = ''
    const start = Math.max(0, st.size - FIRST_SCAN_BYTES)
    logState.offset = start
    fromMiddle = start > 0
  }

  if (st.size <= logState.offset) return logState.sessionId || null

  let text
  try {
    text = readRange(file, logState.offset, st.size)
  } catch (err) {
    return logState.sessionId || null
  }
  logState.offset = st.size

  if (fromMiddle) {
    // 从中间起读，第一段必然是被截断的半行，丢掉
    const nl = text.indexOf('\n')
    text = nl === -1 ? '' : text.slice(nl + 1)
  }

  const combined = (logState.pending || '') + text
  const lines = combined.split(/\r?\n/)
  const tail = lines.pop() || ''
  logState.pending = tail.length > PENDING_MAX ? '' : tail

  for (const line of lines) {
    const sid = extractSessionId(line)
    if (sid) logState.sessionId = sid
  }

  return logState.sessionId || null
}

// ---------- 会话聚合：读 ZCode 用量库 ----------

// 只取主对话调用：query_source='session_title' 是自动生成标题的开销，不算会话本身
const CALLS_SQL = `
  SELECT input_tokens, cache_read_input_tokens, output_tokens,
         COALESCE(completed_at, started_at) AS ts
  FROM model_usage
  WHERE session_id = ? AND query_source = 'main_turn'
  ORDER BY started_at
`

const TITLE_SQL = 'SELECT title FROM session WHERE id = ?'

const FALLBACK_SQL = `
  SELECT session_id FROM model_usage
  WHERE query_source = 'main_turn'
  GROUP BY session_id
  ORDER BY MAX(started_at) DESC
  LIMIT 1
`

function num(v) {
  const n = Number(v)
  return isFinite(n) ? n : 0
}

export function sessionSnapshot() {
  const sqlite = loadSqlite()
  if (!sqlite) return { ok: false, reason: 'no-sqlite' }
  if (!fs.existsSync(DB_FILE)) return { ok: false, reason: 'no-db', db: DB_FILE }

  const fromLog = activeSessionFromLog()
  let db = null
  try {
    db = new sqlite.DatabaseSync(DB_FILE, { readOnly: true, timeout: 2000 })

    let sessionId = fromLog
    if (!sessionId) {
      const row = db.prepare(FALLBACK_SQL).get()
      sessionId = row ? row.session_id : ''
    }
    if (!sessionId) return { ok: false, reason: 'no-session' }

    let title = ''
    try {
      const t = db.prepare(TITLE_SQL).get(sessionId)
      title = (t && t.title) || ''
    } catch (err) {}

    const rows = db.prepare(CALLS_SQL).all(sessionId)

    let hit = 0
    let miss = 0
    let out = 0
    let costHit = 0
    let costMiss = 0
    let costOut = 0
    let peakCalls = 0
    for (const r of rows) {
      const c = costOfCall(
        { input: r.input_tokens, cacheRead: r.cache_read_input_tokens, output: r.output_tokens },
        r.ts
      )
      hit += c.hit
      miss += c.miss
      out += c.out
      costHit += c.costHit
      costMiss += c.costMiss
      costOut += c.costOut
      if (c.peak) peakCalls += 1
    }

    // 已用上下文 = 最近一次主请求的输入总量（缓存命中的部分同样占着窗口）。
    // 跳过 input 为 0 的行：那是被取消/失败的调用留下的空记录。
    let contextUsed = 0
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = num(rows[i].input_tokens)
      if (v > 0) {
        contextUsed = v
        break
      }
    }

    return {
      ok: true,
      sessionId,
      title,
      sessionSource: fromLog ? 'log' : 'db',
      calls: rows.length,
      tokens: { hit, miss, out, total: hit + miss + out },
      cost: { hit: costHit, miss: costMiss, out: costOut, total: costHit + costMiss + costOut },
      context: {
        used: contextUsed,
        limit: CONTEXT_LIMIT,
        percent: CONTEXT_LIMIT > 0 ? (contextUsed / CONTEXT_LIMIT) * 100 : 0,
      },
      mix: { peakCalls, offCalls: rows.length - peakCalls },
      updatedAt: Date.now(),
    }
  } catch (err) {
    return {
      ok: false,
      reason: 'query-failed',
      error: String((err && err.message) || err).slice(0, 200),
    }
  } finally {
    try {
      if (db) db.close()
    } catch (err) {}
  }
}
