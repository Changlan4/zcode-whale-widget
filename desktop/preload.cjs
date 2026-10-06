// 浮层模式下的桥接：页面用它告诉主进程「指针在方框上，请接管鼠标」，
// 接收 ZCode 窗口矩形（页面把它当作自己的视口），以及调整跟随探测间隔。
// 只暴露这几个能力，不向页面开放任何 Node 权限。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('whaleDesktop', {
  isOverlay: true,
  setInteractive: (value) => ipcRenderer.send('whale:interactive', !!value),
  quit: () => ipcRenderer.send('whale:quit'),
  onViewport: (callback) => {
    ipcRenderer.on('whale:viewport', (_event, rect) => {
      try {
        callback(rect)
      } catch (err) {}
    })
  },
  // 浮层被隐藏（ZCode 最小化/被盖住）：页面侧的接管标记需要跟着复位，
  // 否则与主进程的穿透状态不一致，悬停判定会失灵
  onHidden: (callback) => {
    ipcRenderer.on('whale:overlay-hidden', () => {
      try {
        callback()
      } catch (err) {}
    })
  },
  // 跟随探测间隔（毫秒）：值越小方框跟得越紧
  setFollowInterval: (ms) => ipcRenderer.send('whale:follow-interval', Number(ms)),
  getFollowInterval: () => ipcRenderer.invoke('whale:follow-interval-get'),
})
