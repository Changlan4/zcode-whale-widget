// 会话用量方框（桌面浮层 / 网页版共用）。
//
// 显示当前会话自新建以来的累计用量：token 三分（缓存命中 / 未命中 / 输出）、
// 对应的花费、以及已用上下文。会话一换（从会话列表点开别的会话），数字跟着变。
//
// 浮层里的定位机制（见 desktop/main.cjs 的 applyZCodeBounds）：
//   - 浮层窗口铺满整个工作区，主进程把 ZCode 窗口矩形作为「视口」发进来，
//     吸附边界与位置记忆都以这个矩形为准，于是方框看起来待在 ZCode 窗口里
//   - 窗口默认鼠标穿透。指针落在方框上时才让窗口接管鼠标，离开后又交回去。
//     普通浏览器里没有 whaleDesktop，穿透逻辑自动失效、方框始终可交互。
(function () {
  'use strict'

  var POS_KEY = 'zcw-box-pos'
  var VIEW_KEY = 'zcw-box-view'
  var POLL_MS = 5000 // 数据刷新间隔
  var REFRESH_ON_SWITCH_MS = 1200 // 检测到会话切换时的快速补刷间隔

  var bridge = typeof window !== 'undefined' && window.whaleDesktop ? window.whaleDesktop : null

  var root, bodyEl, titleEl, dotEl, rowsEl, ctxBarEl, ctxTextEl, footEl

  // ---------- 数据 ----------
  var snapshot = null
  var errorText = ''
  var lastSessionId = null
  var switchUntil = 0

  function num(v) {
    var n = Number(v)
    return isFinite(n) ? n : 0
  }

  // 千分位整数；超过一亿才缩写（按用户要求，token 一律给全量数字）
  function fmtInt(n) {
    n = Math.round(num(n))
    if (Math.abs(n) >= 1e8) {
      var y = n / 1e8
      return (Math.round(y * 100) / 100) + '亿'
    }
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  }

  function fmtUsd(v) {
    var n = num(v)
    if (n > 0 && n < 0.0001) return '$' + n.toExponential(2)
    if (n < 1) return '$' + n.toFixed(4)
    return '$' + n.toFixed(3)
  }

  function fmtPercent(v) {
    var n = num(v)
    return n.toFixed(1) + '%'
  }

  // ---------- 渲染 ----------
  var ROWS = [
    { key: 'hit', label: '输入 · 命中缓存', color: '#6cc4a8' },
    { key: 'miss', label: '输入 · 未命中', color: '#7aa2f7' },
    { key: 'out', label: '输出', color: '#e0af68' },
  ]

  function buildRow(row) {
    var el = document.createElement('div')
    el.className = 'row'
    el.setAttribute('data-key', row.key)
    el.innerHTML =
      '<span class="swatch" style="background:' +
      row.color +
      '"></span>' +
      '<span class="label"></span>' +
      '<span class="tok"></span>' +
      '<span class="cost"></span>'
    return el
  }

  function buildUi() {
    root = document.createElement('div')
    root.id = 'box'
    root.innerHTML =
      '<div class="head">' +
      '  <span class="dot"></span>' +
      '  <span class="title">会话用量</span>' +
      '</div>' +
      '<div class="body"></div>' +
      '<div class="ctx">' +
      '  <div class="ctxline"><span class="ctxlabel">已用上下文</span>' +
      '    <span class="ctxval"></span></div>' +
      '  <div class="ctxbar"><i></i></div>' +
      '</div>' +
      '<div class="foot"></div>'

    bodyEl = root.querySelector('.body')
    titleEl = root.querySelector('.title')
    dotEl = root.querySelector('.dot')
    ctxBarEl = root.querySelector('.ctxbar i')
    ctxTextEl = root.querySelector('.ctxval')
    footEl = root.querySelector('.foot')

    ROWS.forEach(function (r) {
      bodyEl.appendChild(buildRow(r))
    })

    document.body.appendChild(root)
  }

  function render() {
    if (!snapshot || !snapshot.ok) {
      titleEl.textContent = '会话用量'
      ROWS.forEach(function (r) {
        var el = bodyEl.querySelector('.row[data-key="' + r.key + '"]')
        el.querySelector('.tok').textContent = '--'
        el.querySelector('.cost').textContent = '--'
      })
      ctxTextEl.textContent = '--'
      ctxBarEl.style.width = '0%'
      dotEl.className = 'dot bad'
      footEl.textContent = errorText || '等待数据…'
      return
    }

    var s = snapshot
    titleEl.textContent = s.title || '(未命名会话)'
    titleEl.title = s.title || ''
    dotEl.className = 'dot' + (s.mix && s.mix.peakCalls > 0 ? ' peak' : '')

    ROWS.forEach(function (r) {
      var el = bodyEl.querySelector('.row[data-key="' + r.key + '"]')
      var t = r.key === 'hit' ? s.tokens.hit : r.key === 'miss' ? s.tokens.miss : s.tokens.out
      var c = r.key === 'hit' ? s.cost.hit : r.key === 'miss' ? s.cost.miss : s.cost.out
      el.querySelector('.label').textContent = r.label
      el.querySelector('.tok').textContent = fmtInt(t)
      el.querySelector('.cost').textContent = fmtUsd(c)
    })

    var ctx = s.context || { used: 0, limit: 1, percent: 0 }
    ctxTextEl.textContent = fmtInt(ctx.used) + ' / ' + fmtInt(ctx.limit) + ' · ' + fmtPercent(ctx.percent)
    ctxBarEl.style.width = Math.min(100, Math.max(0, num(ctx.percent))) + '%'

    var peakMark = s.mix && s.mix.peakCalls > 0 ? ' · 含高峰 ' + s.mix.peakCalls + ' 次' : ''
    footEl.textContent =
      '合计 ' +
      fmtInt(s.tokens.total) +
      ' tokens · ' +
      fmtUsd(s.cost.total) +
      peakMark +
      ' · ' +
      s.calls +
      ' 次调用'
  }

  // ---------- 取数 ----------
  var fetching = false

  function fetchOnce() {
    if (fetching) return
    fetching = true
    var url = '/whale/session-usage.json?t=' + Date.now()
    fetch(url, { cache: 'no-store' })
      .then(function (r) {
        return r.json()
      })
      .then(function (data) {
        errorText = ''
        snapshot = data
        if (data && data.ok && data.sessionId) {
          if (lastSessionId !== null && data.sessionId !== lastSessionId) {
            // 会话刚切换：短时间内加密轮询，等新会话的数字稳定下来
            switchUntil = Date.now() + 12000
          }
          lastSessionId = data.sessionId
        }
        render()
        fitWindow()
      })
      .catch(function (err) {
        errorText = '取数失败，重试中…'
        render()
      })
      .then(function () {
        fetching = false
      })
  }

  function startPolling() {
    fetchOnce()
    setInterval(function () {
      fetchOnce()
      if (Date.now() < switchUntil) setTimeout(fetchOnce, REFRESH_ON_SWITCH_MS)
    }, POLL_MS)
  }

  // ---------- 定位 ----------
  var externalViewport = null
  var state = { left: 24, top: 24, v: 'top', h: 'left', vOff: 24, hOff: 24 }
  var restored = false

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v
  }

  function vp() {
    if (externalViewport) return { w: externalViewport.w, h: externalViewport.h }
    return { w: window.innerWidth || 1280, h: window.innerHeight || 800 }
  }

  function express() {
    var ox = externalViewport ? externalViewport.x : 0
    var oy = externalViewport ? externalViewport.y : 0
    root.style.left = ox + state.left + 'px'
    root.style.top = oy + state.top + 'px'
  }

  function settle() {
    var v = vp()
    var w = root.offsetWidth || 0
    var h = root.offsetHeight || 0
    if (state.h === 'right') state.left = Math.max(0, v.w - w - state.hOff)
    else state.left = clamp(state.left, 0, Math.max(0, v.w - w))
    if (state.v === 'bottom') state.top = Math.max(0, v.h - h - state.vOff)
    else state.top = clamp(state.top, 0, Math.max(0, v.h - h))
    express()
  }

  function savePos() {
    try {
      localStorage.setItem(
        POS_KEY,
        JSON.stringify({ left: state.left, top: state.top, v: state.v, h: state.h, vOff: state.vOff, hOff: state.hOff })
      )
    } catch (err) {}
  }

  function restorePos() {
    if (restored) return
    restored = true
    try {
      var raw = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
      if (raw && isFinite(raw.left) && isFinite(raw.top)) {
        // 按锚点还原：窗口尺寸变了也能贴在原来的边上
        if (raw.h === 'right' || raw.h === 'left') {
          state.h = raw.h
          state.hOff = isFinite(raw.hOff) ? raw.hOff : raw.left
          state.left = raw.left
        } else {
          state.h = 'free'
          state.left = raw.left
        }
        if (raw.v === 'bottom' || raw.v === 'top') {
          state.v = raw.v
          state.vOff = isFinite(raw.vOff) ? raw.vOff : raw.top
          state.top = raw.top
        } else {
          state.v = 'free'
          state.top = raw.top
        }
      }
    } catch (err) {}
    try {
      var view = JSON.parse(localStorage.getItem(VIEW_KEY) || 'null')
      if (view && isFinite(view.scale)) applyScale(view.scale)
    } catch (err) {}
  }

  // ---------- 尺寸 ----------
  var scale = 1
  var BASE_W = 300

  function applyScale(next) {
    scale = clamp(num(next) || 1, 0.7, 2.4)
    root.style.width = Math.round(BASE_W * scale) + 'px'
    root.style.fontSize = Math.round(13 * scale) + 'px'
  }

  // 内容变了窗口高度跟着变，再校正一次位置
  function fitWindow() {
    if (!root) return
    settle()
  }

  // ---------- 拖拽 ----------
  function bindDrag() {
    var drag = null
    root.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return
      if (e.target.closest && e.target.closest('button')) return
      drag = { x: e.clientX, y: e.clientY, left: state.left, top: state.top }
      e.preventDefault()
    })
    window.addEventListener('mousemove', function (e) {
      if (!drag) return
      state.left = drag.left + (e.clientX - drag.x)
      state.top = drag.top + (e.clientY - drag.y)
      state.h = 'free'
      state.v = 'free'
      settle()
    })
    window.addEventListener('mouseup', function () {
      if (!drag) return
      drag = null
      snapToEdges()
      savePos()
    })

    root.addEventListener('dblclick', function (e) {
      e.preventDefault()
      fetchOnce()
    })
    root.addEventListener('wheel', function (e) {
      if (!e.ctrlKey && !e.altKey) return
      e.preventDefault()
      applyScale(scale + (e.deltaY < 0 ? 0.1 : -0.1))
      try {
        localStorage.setItem(VIEW_KEY, JSON.stringify({ scale: scale }))
      } catch (err) {}
      settle()
    }, { passive: false })
  }

  // 松手后若贴近某条边，就吸附并记成锚点，窗口缩放时继续贴边
  function snapToEdges() {
    var v = vp()
    var w = root.offsetWidth || 0
    var h = root.offsetHeight || 0
    var EDGE = 24
    if (state.left <= EDGE) {
      state.h = 'left'
      state.hOff = 8
      state.left = state.hOff
    } else if (state.left + w >= v.w - EDGE) {
      state.h = 'right'
      state.hOff = 8
      state.left = Math.max(0, v.w - w - state.hOff)
    } else {
      state.h = 'free'
    }
    if (state.top <= EDGE) {
      state.v = 'top'
      state.vOff = 8
      state.top = state.vOff
    } else if (state.top + h >= v.h - EDGE) {
      state.v = 'bottom'
      state.vOff = 8
      state.top = Math.max(0, v.h - h - state.vOff)
    } else {
      state.v = 'free'
    }
    settle()
  }

  // ---------- 浮层：鼠标接管 ----------
  var interactive = false
  var lastPointer = null

  function setInteractive(next) {
    if (!bridge || interactive === !!next) return
    interactive = !!next
    try {
      bridge.setInteractive(interactive)
    } catch (err) {}
  }

  function shouldInteract() {
    if (!lastPointer) return false
    try {
      var el = document.elementFromPoint(lastPointer.x, lastPointer.y)
      if (!el) return false
      // 方框是不透明的实体块，落在它上面就接管；换成穿透时点击会落到 ZCode
      return !!(el === root || (root.contains && root.contains(el)))
    } catch (err) {
      return false
    }
  }

  function bindOverlay() {
    if (!bridge) return
    document.addEventListener('mousemove', function (e) {
      lastPointer = { x: e.clientX, y: e.clientY }
      setInteractive(shouldInteract())
    })
    document.addEventListener('mouseleave', function () {
      lastPointer = null
      setInteractive(false)
    })
    if (typeof bridge.onViewport === 'function') {
      bridge.onViewport(function (rect) {
        if (!rect || typeof rect.width !== 'number' || rect.width <= 0) return
        var first = externalViewport === null
        externalViewport = { x: rect.x, y: rect.y, w: rect.width, h: rect.height }
        if (first) restorePos()
        settle()
      })
    }
  }

  // ---------- 启动 ----------
  function boot() {
    buildUi()
    applyScale(1)
    bindDrag()

    if (bridge) {
      root.classList.add('overlay')
      bindOverlay()
    } else {
      restorePos()
    }

    settle()
    startPolling()
    // 字体加载完尺寸会变，重新校正一次
    if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
      document.fonts.ready.then(function () {
        settle()
      })
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
