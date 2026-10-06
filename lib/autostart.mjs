// SessionStart 自启：对应上游「每次打开界面自动启用（常驻自启）」。
//
// 作为 ZCode 的 SessionStart hook 运行。hook 的 stdout 会被当作 JSON 严格
// 校验，所以这里全程静默——任何成功/失败都不输出内容，只保证：
//   1. 挂件服务被拉起（默认开启，config.autoStartWidget=false 可关）
//   2. Electron 运行时已装的情况下，顺便把桌面浮层也拉到桌面上
//      （config.autoStartOverlay=false 可关）
//
// 每次运行都会往 ~/.zcode/whale/autostart.log 追加一行结果，方便确认
// 「打开 ZCode 时方框有没有被自动拉起」。
import fs from 'node:fs'
import path from 'node:path'
import { readPluginConfig } from './credentials.mjs'
import { ensureServer } from './service.mjs'
import { isRuntimeInstalled, startOverlay } from './overlay.mjs'
import { DATA_DIR } from './paths.mjs'

const LOG_FILE = path.join(DATA_DIR, 'autostart.log')
const LOG_KEEP_LINES = 200

function record(text) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + text + '\n', 'utf8')
    // 只留最近若干行，避免长期运行后无限增长
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).filter(Boolean)
    if (lines.length > LOG_KEEP_LINES) {
      fs.writeFileSync(LOG_FILE, lines.slice(-LOG_KEEP_LINES).join('\n') + '\n', 'utf8')
    }
  } catch (err) {}
}

try {
  const cfg = readPluginConfig()
  if (!cfg.autoStartWidget) {
    record('skip: autoStartWidget=false')
  } else {
    const svc = await ensureServer({ waitReadyMs: 5000 })
    let overlayNote = 'skipped'
    if (svc.running && cfg.autoStartOverlay) {
      if (isRuntimeInstalled()) {
        const r = await startOverlay()
        overlayNote = r.running ? (r.started ? 'started' : 'reused') : 'failed:' + (r.error || 'unknown')
      } else {
        overlayNote = 'skipped:no-runtime'
      }
    }
    record(
      'server=' + (svc.running ? (svc.started ? 'started' : 'reused') : 'failed:' + (svc.error || 'unknown')) +
        ' overlay=' + overlayNote
    )
  }
} catch (err) {
  // 自启失败不能影响会话启动；需要排查时看 autostart.log 的上一行
  record('error: ' + String((err && err.message) || err))
}
