// 每轮对话消耗：读取 ZCode 自己记录的 turn 用量并换算成金额。
//
// 上游 DSH 版监听宿主进程的 session/event 事件流（assistant/message 带真实
// usage，turn/end 时结算）。ZCode 插件拿不到进程内事件，但 ZCode 会把每一轮
// 的真实 token 用量落库到 <ZCODE_HOME>/cli/db/db.sqlite 的 turn_usage 表，
// 语义完全对应，所以这里改为查询该表；数据库不可用时回退到模型 I/O 日志。
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { DB_FILE, ROLLOUT_DIR } from './paths.mjs'
import { costOfUsage } from './pricing.mjs'

const require = createRequire(import.meta.url)
const TAIL_BYTES = 256 * 1024

let sqliteModule = null
let sqliteProbed = false

function loadSqlite() {
  if (sqliteProbed) return sqliteModule
  sqliteProbed = true
  try {
    // node:sqlite 自 Node 22.5 起内置；拿不到就退回日志解析。
    sqliteModule = require('node:sqlite')
  } catch (err) {
    sqliteModule = null
  }
  return sqliteModule
}

const TURN_QUERY = `
  SELECT
    t.session_id,
    t.turn_id,
    t.input_tokens,
    t.output_tokens,
    t.reasoning_tokens,
    t.cache_read_input_tokens,
    t.cache_creation_input_tokens,
    COALESCE(t.completed_at, t.started_at) AS ts,
    (SELECT m.model_id FROM model_usage m
      WHERE m.session_id = t.session_id AND m.turn_id = t.turn_id
      ORDER BY m.started_at DESC LIMIT 1) AS model_id
  FROM turn_usage t
  WHERE t.status = 'completed'
  ORDER BY COALESCE(t.completed_at, t.started_at) DESC
  LIMIT 1
`

function readFromDatabase() {
  const sqlite = loadSqlite()
  if (!sqlite || !fs.existsSync(DB_FILE)) return null
  let db = null
  try {
    db = new sqlite.DatabaseSync(DB_FILE, { readOnly: true, timeout: 2000 })
    const row = db.prepare(TURN_QUERY).get()
    if (!row) return null
    return {
      source: 'turn_usage',
      sessionId: row.session_id,
      turnId: row.turn_id,
      ts: Number(row.ts) || Date.now(),
      model: row.model_id || '',
      usage: {
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        reasoning_tokens: row.reasoning_tokens,
        cache_read_input_tokens: row.cache_read_input_tokens,
        cache_creation_input_tokens: row.cache_creation_input_tokens,
      },
    }
  } catch (err) {
    return null
  } finally {
    try {
      if (db) db.close()
    } catch (err) {}
  }
}

// 回退路径：模型 I/O 日志每行是一次模型请求，取最后一笔主对话的 usage。
function readFromRollout() {
  let entries = []
  try {
    entries = fs
      .readdirSync(ROLLOUT_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && /^model-io-.*\.jsonl$/.test(e.name))
      .map((e) => {
        const full = path.join(ROLLOUT_DIR, e.name)
        try {
          return { full, mtime: fs.statSync(full).mtimeMs }
        } catch (err) {
          return null
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime)
  } catch (err) {
    return null
  }
  for (const entry of entries) {
    let text = ''
    try {
      const stat = fs.statSync(entry.full)
      const start = Math.max(0, stat.size - TAIL_BYTES)
      const fd = fs.openSync(entry.full, 'r')
      try {
        const buf = Buffer.alloc(stat.size - start)
        fs.readSync(fd, buf, 0, buf.length, start)
        text = buf.toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) {
      continue
    }
    const lines = text.split(/\r?\n/).filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      let o
      try {
        o = JSON.parse(lines[i])
      } catch (err) {
        continue // 截断的首行必然不完整，跳过
      }
      const usage = o && o.response && o.response.usage
      const role = o && o.model && o.model.role
      if (!usage || role !== 'main') continue
      return {
        source: 'rollout',
        sessionId: o.sessionId || '',
        turnId: o.turnId || '',
        ts: Date.parse(o.completedAt) || Date.now(),
        model: (o.model && o.model.modelId) || (o.response && o.response.modelId) || '',
        usage,
      }
    }
  }
  return null
}

// 返回最近一轮完成的消耗，已换算金额。读不到数据时返回 ok:false 但仍是
// 结构化结果，前端不会因此报错。
export function readLatestTurn() {
  const raw = readFromDatabase() || readFromRollout()
  if (!raw) {
    return { ok: false, reason: 'no-turn-data' }
  }
  const cost = costOfUsage(raw.model, raw.usage, raw.ts)
  return {
    ok: true,
    source: raw.source,
    sessionId: raw.sessionId,
    turnId: raw.turnId,
    ts: raw.ts,
    model: raw.model,
    tokens: cost.tokens,
    peak: cost.peak,
    tier: cost.tier,
    amount: cost.amount,
    // 明细：让调用方可以展示「为什么是这个数」，也便于核对计价口径
    breakdown: cost.breakdown,
  }
}

export { costOfUsage }
