// 演示/人工验收：用假数据起一个方框服务，并周期性往当前会话追加用量，
// 用于在浏览器里观察方框的数字往上跳、以及切换会话时数字整体改变。
// 全程使用临时 ZCODE_HOME，不读写真实会话库。
//
//   node tools/demo.mjs            # 随机端口
//   node tools/demo.mjs 39999      # 指定端口
//
// 打开打印出的地址即可；每 6 秒往当前会话加一次调用，每 30 秒切到另一个会话。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'session-box-demo-'))
const dbDir = path.join(tmpHome, 'cli', 'db')
const dataDir = path.join(tmpHome, 'whale')
const logDir = path.join(tmpHome, 'v2', 'logs')
fs.mkdirSync(dbDir, { recursive: true })
fs.mkdirSync(dataDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })

const port = Number(process.argv[2]) || 39500 + Math.floor(Math.random() * 400)
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ port }), 'utf8')

const db = new DatabaseSync(path.join(dbDir, 'db.sqlite'))
db.exec(`
  CREATE TABLE session (id text primary key, title text not null);
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

const SESSIONS = [
  { id: 'sess_demo_alpha', title: '演示 · 会话甲' },
  { id: 'sess_demo_beta', title: '演示 · 会话乙' },
]
for (const s of SESSIONS) {
  db.prepare('INSERT INTO session (id, title) VALUES (?, ?)').run(s.id, s.title)
}

const logFile = path.join(logDir, '2026-01-01.log')
function writeAcquire(sessionId) {
  fs.appendFileSync(
    logFile,
    `[2026-01-01 00:00:00.000] [info] [pid:1] [renderer] v4 session data lease acquired ` +
      `{"event":"v4.session_data.acquire","sessionId":"${sessionId}","openKind":"cold"}\n`,
    'utf8'
  )
}

let muSeq = 0
// 每个会话各自维护「上下文增长」：同一会话里随工具结果累积，模拟真实增长曲线
const ctx = { sess_demo_alpha: 90_000, sess_demo_beta: 40_000 }

function addCall(sessionId) {
  muSeq += 1
  ctx[sessionId] += 4_000 + Math.floor(Math.random() * 12_000)
  const input = ctx[sessionId]
  const cacheRead = Math.floor(input * 0.9)
  const output = 500 + Math.floor(Math.random() * 3_000)
  const now = Date.now()
  db.prepare(
    `INSERT INTO model_usage (id, session_id, query_source, input_tokens, cache_read_input_tokens,
      output_tokens, reasoning_tokens, started_at, completed_at)
     VALUES (?, ?, 'main_turn', ?, ?, ?, 0, ?, ?)`
  ).run('mu-' + muSeq, sessionId, input, cacheRead, output, now - 2000, now)
}

let current = 0
writeAcquire(SESSIONS[0].id)
addCall(SESSIONS[0].id) // 先给甲一点底子

const child = spawn(process.execPath, [path.join(PLUGIN_ROOT, 'lib', 'server.mjs')], {
  cwd: PLUGIN_ROOT,
  env: { ...process.env, ZCODE_HOME: tmpHome },
  stdio: 'ignore',
})

console.log('📊 方框演示服务已启动')
console.log('   地址: http://127.0.0.1:' + port + '/')
console.log('   临时数据目录: ' + tmpHome)
console.log('   每 6 秒往当前会话加一次调用；每 30 秒切换会话\n')

const callTimer = setInterval(() => {
  const s = SESSIONS[current]
  addCall(s.id)
  console.log('  + ' + s.title + ' 新增一次调用，上下文 ' + ctx[s.id].toLocaleString())
}, 6000)

const switchTimer = setInterval(() => {
  current = (current + 1) % SESSIONS.length
  const s = SESSIONS[current]
  writeAcquire(s.id)
  console.log('  ⇄ 切换到 ' + s.title)
}, 30000)

function cleanup() {
  clearInterval(callTimer)
  clearInterval(switchTimer)
  try {
    child.kill()
  } catch (err) {}
  try {
    db.close()
  } catch (err) {}
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
    console.log('\n已清理临时数据目录')
  } catch (err) {}
  process.exit(0)
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
