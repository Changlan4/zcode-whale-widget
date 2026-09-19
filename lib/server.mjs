// 本地 HTTP 服务：会话用量方框的数据与页面。
//
// ZCode 插件没有「往界面注入脚本」的能力，所以自带一个独立页面：桌面浮层
// 加载它，浏览器打开 http://127.0.0.1:<port>/ 也是同一个方框。
//
// 安全边界（本地服务容易被任意网页探测）：
//   - 只监听 127.0.0.1，不对外暴露
//   - 校验 Host 头，防 DNS rebinding
//   - 写操作校验 Origin，拒绝跨站伪造
//   - 关闭服务需要 server.json 里的随机令牌
//   - 不返回通配 CORS 头（页面与接口同源，不需要跨域）
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_ID, DEFAULT_PORT, SERVER_INFO_FILE, WIDGET_STATE_FILE } from './paths.mjs'
import { readWidgetState } from './balance.mjs'
import { findApiKey, maskKey, readPluginConfig } from './credentials.mjs'
import { boxCss } from './box-css.mjs'
import { sessionSnapshot } from './session-usage.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BOX_JS = path.join(HERE, 'box.js')
const VERSION = '1.0.0'
const TOKEN = crypto.randomBytes(16).toString('hex')

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// ---------- 请求校验 ----------
function hostAllowed(req, port) {
  const host = String(req.headers.host || '')
  const allowed = ['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port]
  return allowed.indexOf(host) !== -1
}

function originAllowed(req, port) {
  const origin = req.headers.origin
  if (!origin) return true // 非浏览器请求（curl 等）没有 Origin
  const allowed = ['http://127.0.0.1:' + port, 'http://localhost:' + port, 'http://[::1]:' + port]
  return allowed.indexOf(String(origin)) !== -1
}

function sendJson(res, status, payload) {
  let body
  try {
    body = JSON.stringify(payload)
  } catch (err) {
    body = JSON.stringify({ ok: false, error: '序列化失败' })
  }
  res.writeHead(status, JSON_HEADERS)
  res.end(body)
}

// ---------- 独立页面 ----------
// 背景透明：浮层里方框直接浮在 ZCode 界面上；普通浏览器里是白底 + 方框。
function pageHtml(port, dark) {
  const bg = dark ? '#12161f' : 'transparent'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>会话用量 · ZCode</title>
<style>
  html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:${bg}}
${boxCss()}
</style>
</head>
<body>
<script defer src="/whale/box.js"></script>
</body>
</html>
`
}

// ---------- 路由 ----------
function createRequestHandler(port) {
  return async function handle(req, res) {
    if (!hostAllowed(req, port)) {
      sendJson(res, 403, { ok: false, error: 'host not allowed' })
      return
    }
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1:' + port)
    } catch (err) {
      sendJson(res, 400, { ok: false, error: 'bad request' })
      return
    }
    const pathname = url.pathname
    const method = (req.method || 'GET').toUpperCase()
    const isWrite = method === 'PUT' || method === 'POST' || method === 'DELETE'
    if (isWrite && !originAllowed(req, port)) {
      sendJson(res, 403, { ok: false, error: 'origin not allowed' })
      return
    }

    // 页面
    if (pathname === '/' || pathname === '/index.html') {
      const html = pageHtml(port, url.searchParams.get('bg') === 'dark')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(html)
      return
    }

    // 前端脚本
    if (pathname === '/whale/box.js') {
      try {
        const js = fs.readFileSync(BOX_JS)
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': String(js.length),
        })
        res.end(js)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('box.js unavailable')
      }
      return
    }

    // 会话用量：当前会话的累计 token / 花费 / 已用上下文
    if (pathname === '/whale/session-usage.json') {
      try {
        sendJson(res, 200, sessionSnapshot())
      } catch (err) {
        sendJson(res, 200, {
          ok: false,
          reason: 'error',
          error: String((err && err.message) || err).slice(0, 200),
        })
      }
      return
    }

    // 健康检查：给命令、MCP、hook 用来判断服务是否已在跑
    if (pathname === '/whale/health') {
      const cfg = readPluginConfig()
      const found = findApiKey()
      sendJson(res, 200, {
        ok: true,
        app: APP_ID,
        version: VERSION,
        pid: process.pid,
        port,
        usageMode: readWidgetState().usageMode,
        keySource: found.source,
        keyMasked: maskKey(found.key),
        stateFile: WIDGET_STATE_FILE,
        portPinned: cfg.port,
      })
      return
    }

    // 关闭服务（需要 server.json 里的令牌，防止别的本地程序随手关掉）
    if (pathname === '/whale/shutdown' && isWrite) {
      if (String(req.headers['x-whale-token'] || '') !== TOKEN) {
        sendJson(res, 403, { ok: false, error: 'bad token' })
        return
      }
      sendJson(res, 200, { ok: true, stopping: true })
      setTimeout(() => stop(0), 50)
      return
    }

    sendJson(res, 404, { ok: false, error: 'not found' })
  }
}

// ---------- 生命周期 ----------
let server = null
let boundPort = null

function writeServerInfo(port) {
  try {
    fs.mkdirSync(path.dirname(SERVER_INFO_FILE), { recursive: true })
    fs.writeFileSync(
      SERVER_INFO_FILE,
      JSON.stringify(
        {
          pid: process.pid,
          port,
          url: 'http://127.0.0.1:' + port + '/',
          token: TOKEN,
          version: VERSION,
          startedAt: new Date().toISOString(),
        },
        null,
        2
      ),
      'utf8'
    )
  } catch (err) {}
}

function clearServerInfo() {
  try {
    const info = JSON.parse(fs.readFileSync(SERVER_INFO_FILE, 'utf8'))
    // 只清理自己写下的记录，避免误删新进程的信息
    if (info && info.pid === process.pid) fs.unlinkSync(SERVER_INFO_FILE)
  } catch (err) {}
}

function stop(code) {
  clearServerInfo()
  try {
    if (server) server.close()
  } catch (err) {}
  // 给 in-flight 响应一点时间落地
  setTimeout(() => process.exit(code), 60)
}

// 端口占用时向后顺延，避免和其它本地服务抢端口
function listen(port, attemptsLeft) {
  server = http.createServer(createRequestHandler(port))
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && attemptsLeft > 0) {
      try {
        server.close()
      } catch (e) {}
      listen(port + 1, attemptsLeft - 1)
      return
    }
    console.error('[zcode-session-box] 无法启动服务:', String((err && err.message) || err))
    process.exit(1)
  })
  server.listen(port, '127.0.0.1', () => {
    boundPort = port
    writeServerInfo(port)
    console.log('📊 会话用量方框已就绪: http://127.0.0.1:' + port + '/')
    console.log('   数据目录: ' + path.dirname(WIDGET_STATE_FILE))
  })
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

const configPort = readPluginConfig().port
listen(configPort || DEFAULT_PORT, 20)

export { boundPort, stop }
