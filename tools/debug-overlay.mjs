// 浮层诊断：通过 CDP 连进浮层页面，看它到底收到了什么鼠标事件、
// 菜单能否被打开。用于排查「点不动鲸鱼」这类问题。
//
//   WHALE_DEBUG_PORT=9333 node lib/cli.mjs window start
//   node tools/debug-overlay.mjs            # 默认连 9333
import { readFileSync } from 'node:fs'
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}))
  return r.result.value
}

// 1. 环境与状态
console.log(
  '\n[1] 环境\n' +
    JSON.stringify(
      await evaluate(`({
        hasBridge: !!window.whaleDesktop,
        overlayFlag: window.whaleDesktop ? window.whaleDesktop.isOverlay : null,
        dpr: window.devicePixelRatio,
        viewport: [innerWidth, innerHeight],
        rootClass: document.querySelector('.zcwv-root').className,
        menuOpen: document.querySelector('.zcwv-menu').classList.contains('zcwv-menu-open'),
        menuBtnVisible: document.querySelector('.zcwv-menu-btn').classList.contains('zcwv-menu-btn-visible'),
        btnRect: (function(){var b=document.querySelector('.zcwv-menu-btn').getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}})(),
        imgRect: (function(){var b=document.querySelector('.zcwv-img').getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}})(),
        rootRect: (function(){var b=document.querySelector('.zcwv-root').getBoundingClientRect();return {x:b.x,y:b.y,w:b.width,h:b.height}})(),
      })`),
      null,
      1
    )
)

// 1b. 页面实际加载到的 widget.js 是新版还是旧版
console.log(
  '\n[1b] 页面加载的 widget.js\n' +
    JSON.stringify(
      await evaluate(`
        fetch('/whale/widget.js', { cache: 'no-store' })
          .then(function (r) { return r.text() })
          .then(function (t) {
            return {
              length: t.length,
              hasNewLogic: t.indexOf('pointerInMenuBtnRect') !== -1,
              hasSyncOverlay: t.indexOf('syncOverlayInteractive') !== -1,
            }
          })
      `),
      null,
      1
    )
)

// 2. 注入事件记录器，随后用真实鼠标在页面外移动，看页面能收到哪些事件
await evaluate(`
  window.__dbg = { move: [], down: [], click: [], ipc: [] };
  document.addEventListener('pointermove', function(e){ if(window.__dbg.move.length<40) window.__dbg.move.push([Math.round(e.clientX),Math.round(e.clientY)]) }, true);
  document.addEventListener('pointerdown', function(e){ window.__dbg.down.push([Math.round(e.clientX),Math.round(e.clientY)]) }, true);
  document.addEventListener('click', function(e){ window.__dbg.click.push([Math.round(e.clientX),Math.round(e.clientY)]) }, true);
  if (window.whaleDesktop && window.whaleDesktop.setInteractive) {
    var orig = window.whaleDesktop.setInteractive;
    window.whaleDesktop.setInteractive = function(v){ window.__dbg.ipc.push(!!v); return orig.call(window.whaleDesktop, v) };
  }
  'installed'
`)
console.log('[2] 已注入事件记录器（pointermove/pointerdown/click + setInteractive 调用）')
await send('Runtime.enable')

// 2b. 定点测试：把指针派发到鲸鱼中心，看是否触发 setInteractive
console.log('\n[2b] 把指针派发到鲸鱼中心，检查是否触发 setInteractive')
await evaluate('window.__dbg.ipc.length = 0; 1')
const img = await evaluate(
  `(function(){var b=document.querySelector('.zcwv-img').getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`
)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: img.x, y: img.y })
await new Promise((r) => setTimeout(r, 300))
console.log(
  '  鲸鱼中心 ' +
    JSON.stringify(img) +
    ' -> ' +
    JSON.stringify(
      await evaluate(`({
        ipc: window.__dbg.ipc,
        cursor: document.body.style.cursor,
        menuBtnVisible: document.querySelector('.zcwv-menu-btn').classList.contains('zcwv-menu-btn-visible')
      })`)
    )
)

// 2c. 再派发到按钮矩形（该处鲸鱼图片是透明的，正是之前点不到的坑）
await evaluate('window.__dbg.ipc.length = 0; 1')
const btnPt = await evaluate(
  `(function(){var b=document.querySelector('.zcwv-menu-btn').getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`
)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: btnPt.x, y: btnPt.y })
await new Promise((r) => setTimeout(r, 300))
console.log(
  '  按钮矩形 ' +
    JSON.stringify(btnPt) +
    ' -> ' +
    JSON.stringify(
      await evaluate(`({
        ipc: window.__dbg.ipc,
        menuBtnVisible: document.querySelector('.zcwv-menu-btn').classList.contains('zcwv-menu-btn-visible')
      })`)
    )
)

// 2d. 移开（屏幕中部），确认会恢复穿透
await evaluate('window.__dbg.ipc.length = 0; 1')
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1280, y: 400 })
await new Promise((r) => setTimeout(r, 300))
console.log(
  '  移开到屏幕中部 -> ' + JSON.stringify(await evaluate('window.__dbg.ipc'))
)

// 3. 用 CDP 直接向页面派发真实点击（走 Chromium 输入管线），验证页面逻辑
const btn = await evaluate(
  `(function(){var b=document.querySelector('.zcwv-menu-btn').getBoundingClientRect();return {x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)}})()`
)
console.log('[3] 用 CDP 点击菜单按钮中心 ' + JSON.stringify(btn))
for (const [type, extra] of [
  ['mouseMoved', {}],
  ['mousePressed', { button: 'left', clickCount: 1, buttons: 1 }],
  ['mouseReleased', { button: 'left', clickCount: 1, buttons: 0 }],
]) {
  await send('Input.dispatchMouseEvent', { type, x: btn.x, y: btn.y, ...extra })
  await new Promise((r) => setTimeout(r, 80))
}
await new Promise((r) => setTimeout(r, 400))
console.log(
  '[3] 点击后菜单状态: ' +
    JSON.stringify(
      await evaluate(`({
        menuOpen: document.querySelector('.zcwv-menu').classList.contains('zcwv-menu-open'),
        down: window.__dbg.down,
        click: window.__dbg.click,
        ipc: window.__dbg.ipc
      })`)
    )
)

// 4. 关闭菜单，给真实鼠标留出观察窗口
console.log('\n[4] 接下来 8 秒会把鼠标记录暴露出来 —— 请在屏幕上把鼠标移到右下角鲸鱼身上再移开。')
await new Promise((r) => setTimeout(r, 8000))
console.log(
  '[4] 页面收到的事件：\n' +
    JSON.stringify(
      await evaluate(`({
        moveCount: window.__dbg.move.length,
        firstMoves: window.__dbg.move.slice(0, 5),
        lastMoves: window.__dbg.move.slice(-5),
        down: window.__dbg.down,
        click: window.__dbg.click,
        ipc: window.__dbg.ipc
      })`),
      null,
      1
    )
)

ws.close()
process.exit(0)
