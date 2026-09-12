// 浮层模式下的桥接：页面用它告诉主进程「现在指针在鲸鱼上，请接管鼠标」，
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
  // 跟随探测间隔（毫秒）：值越小鲸鱼跟得越紧
  setFollowInterval: (ms) => ipcRenderer.send('whale:follow-interval', Number(ms)),
  getFollowInterval: () => ipcRenderer.invoke('whale:follow-interval-get'),
})
