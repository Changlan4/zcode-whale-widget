// 浮层诊断：通过 CDP 连进浮层页面，看方框的定位、鼠标接管与数据渲染是否正常。
// 用于排查「点不动方框」「数字不更新」「位置跑偏」这类问题。
//
//   WHALE_DEBUG_PORT=9333 node lib/cli.mjs window start
//   node tools/debug-overlay.mjs            # 默认连 9333
import http from 'node:http'

const PORT = Number(process.argv[2]) || 9333

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path }, (res) => {
        let b = ''
        res.on('data', (c) => (b += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(b))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

const targets = await getJson('/json/list')
const page = targets.find((t) => t.type === 'page' && String(t.url).includes('127.0.0.1'))
if (!page) {
  console.error('没找到浮层页面 target：', targets.map((t) => t.type + ' ' + t.url).join(' | '))
  process.exit(1)
}
console.log('连接页面:', page.url)

const ws = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()

function send(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params: params || {} }))
  })
}

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.method === 'Runtime.exceptionThrown') {
    console.log('  !! 页面异常:', JSON.stringify(msg.params.exceptionDetails).slice(0, 500))
  }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)))
    else p.resolve(msg.result)
  }
})

await new Promise((r) => ws.addEventListener('open', r, { once: true }))

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}))
  }
  return r.result.value
}

// 1. 环境与方框几何
console.log(
  '\n[1] 环境与方框几何\n' +
    JSON.stringify(
      await evaluate(`(function(){
        var box = document.getElementById('box');
        var b = box ? box.getBoundingClientRect() : null;
        return {
          hasBridge: !!window.whaleDesktop,
          overlayFlag: window.whaleDesktop ? window.whaleDesktop.isOverlay : null,
          dpr: window.devicePixelRatio,
          pageViewport: [innerWidth, innerHeight],
          boxExists: !!box,
          boxRect: b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } : null,
          boxClass: box ? box.className : null,
        };
      })()`),
      null,
      1
    )
)

// 1b. 页面加载到的 box.js 是否正确（避免缓存/旧副本）
console.log(
  '\n[1b] 页面加载的 box.js\n' +
    JSON.stringify(
      await evaluate(`
        fetch('/whale/box.js', { cache: 'no-store' })
          .then(function (r) { return r.text() })
          .then(function (t) {
            return {
              length: t.length,
              hasPoll: t.indexOf('session-usage.json') !== -1,
              hasOverlayLogic: t.indexOf('setInteractive') !== -1,
            }
          })
      `),
      null,
      1
    )
)

// 1c. 接口数据与页面显示是否一致
console.log(
  '\n[1c] 接口数据\n' +
    JSON.stringify(
      await evaluate(`
        fetch('/whale/session-usage.json', { cache: 'no-store' })
          .then(function (r) { return r.json() })
          .then(function (d) { return {
            ok: d.ok, sessionSource: d.sessionSource, title: d.title,
            tokens: d.tokens, cost: d.cost, context: d.context
          } })
      `),
      null,
      1
    )
)
console.log(
  '[1c] 页面显示的文本\n' +
    JSON.stringify(
      await evaluate(`(function(){
        var rows = [].slice.call(document.querySelectorAll('#box .row'));
        return {
          title: (document.querySelector('#box .title') || {}).textContent,
          rows: rows.map(function(r){ return {
            key: r.getAttribute('data-key'),
            tok: r.querySelector('.tok').textContent,
            cost: r.querySelector('.cost').textContent
          } }),
          ctx: (document.querySelector('#box .ctxval') || {}).textContent,
          ctxBarWidth: (document.querySelector('#box .ctxbar i') || {}).style ? document.querySelector('#box .ctxbar i').style.width : null,
          foot: (document.querySelector('#box .foot') || {}).textContent
        };
      })()`),
      null,
      1
    )
)

// 2. 鼠标接管判定
// 注意：preload 用 contextBridge 暴露的对象是**冻结**的（writable:false），
// 没法在这里包一层记录 setInteractive 调用。所以改为两件事：
//   a. 直接验证页面自己的判定函数（elementFromPoint 是否命中方框）
//   b. 读主进程的 overlay-debug.log —— 那里记录了每次 interactive 切换，最权威
await evaluate(`
  window.__dbg = { move: [], click: [] };
  document.addEventListener('pointermove', function(e){ if(window.__dbg.move.length<40) window.__dbg.move.push([Math.round(e.clientX),Math.round(e.clientY)]) }, true);
  document.addEventListener('click', function(e){ window.__dbg.click.push([Math.round(e.clientX),Math.round(e.clientY)]) }, true);
  'installed'
`)
console.log('\n[2] 已注入事件记录器（pointermove/click）')
await send('Runtime.enable')

console.log(
  '  bridge 是否可写: ' +
    JSON.stringify(
      await evaluate(`(function(){
        var d = Object.getOwnPropertyDescriptor(window.whaleDesktop, 'setInteractive');
        return { writable: d ? d.writable : null, frozen: Object.isFrozen(window.whaleDesktop) };
      })()`)
    ) +
    '（冻结属正常，无法在此拦截调用）'
)

// 2b. 方框内 / 方框外的命中判定（页面据此决定是否接管鼠标）
console.log(
  '  命中判定: ' +
    JSON.stringify(
      await evaluate(`(function(){
        var box = document.getElementById('box');
        var b = box.getBoundingClientRect();
        var c = document.elementFromPoint(Math.round(b.x + b.width/2), Math.round(b.y + b.height/2));
        var o = document.elementFromPoint(5, 5);
        function inBox(el){ return !!(el && (el === box || box.contains(el))) }
        return {
          centerEl: c ? (c.id || c.className || c.tagName) : null,
          centerInBox: inBox(c),
          cornerEl: o ? (o.id || o.className || o.tagName) : null,
          cornerInBox: inBox(o),
        };
      })()`),
      null,
      1
    )
)

// 2c. 把指针派发到方框中心，再移开
const center = await evaluate(
  `(function(){var b=document.getElementById('box').getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`
)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: center.x, y: center.y })
await new Promise((r) => setTimeout(r, 300))
console.log('  指针移到方框中心 ' + JSON.stringify(center) + '，页面收到 mousemove: ' + JSON.stringify(await evaluate('window.__dbg.move.slice(-2)')))
console.log(
  '  → 主进程应记录 ipc-interactive true。核对命令：\n' +
    '    grep interactive "$HOME/.zcode/whale/overlay-debug.log" | tail -4'
)

// 3. 数据是否随时间更新（等两次轮询）
console.log('\n[4] 等待 12 秒观察数字是否刷新（每 5 秒一次轮询）')
const snap1 = await evaluate(`document.querySelector('#box .foot').textContent`)
await new Promise((r) => setTimeout(r, 12000))
const snap2 = await evaluate(`document.querySelector('#box .foot').textContent`)
console.log('  首次: ' + snap1)
console.log('  之后: ' + snap2)
console.log('  ' + (snap1 === snap2 ? '（未变化：当前会话这段时间没有新调用，属正常）' : '（已刷新）'))

ws.close()
process.exit(0)
