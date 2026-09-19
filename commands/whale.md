---
description: 查看会话用量方框状态、DeepSeek 余额、今日已用与上一轮消耗，或启停方框服务与桌面浮层
argument-hint: "[status|start|stop|turn|url|window start|window stop|key <sk-...>|mode ledger|token]"
allowed-tools: Bash, mcp__whale__whale_balance, mcp__whale__whale_widget, mcp__whale__whale_last_turn, mcp__whale__whale_config
---

用户请求操作 ZCode 的**会话用量方框**（浮在 ZCode 界面上的面板，显示当前会话的累计 token / 花费 / 已用上下文；余额与每轮消耗为附带能力）。参数：`$ARGUMENTS`

注意：方框本身的数字来自本地数据库，**没有对应的 MCP 工具**——用户问「当前会话用了多少」时，直接读 `http://127.0.0.1:<port>/whale/session-usage.json`（`node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" json` 会给出端口），或让用户看屏幕上的方框。

按参数分派：

- 空 / `status`：调用 `whale_widget`（`action=status`）报告服务与浮层是否在运行、地址是什么；再调用 `whale_balance` 报告余额、今日已用、当前峰谷时段（余额失败不影响结论，说明即可）。
- `start`：调用 `whale_widget`（`action=start`），把返回的地址告诉用户，并提示用浏览器打开即可看到方框。
- `stop`：调用 `whale_widget`（`action=stop`）。
- `url`：调用 `whale_widget`（`action=url`），只回地址。
- `turn`：调用 `whale_last_turn`，报告上一轮对话消耗的金额、模型、token 数与计价时段。
- `window start`：调用 `whale_widget`（`action=overlay_start`），把方框作为**桌面浮层**显示在 ZCode 界面之上（透明置顶、默认鼠标穿透，不挡操作）。若返回"需要运行 Electron 运行时"，就让用户在终端执行 `node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" desktop install`（一次性，约 150MB）后重试。
- `window stop`：调用 `whale_widget`（`action=overlay_stop`）。
- `window status`：调用 `whale_widget`（`action=overlay_status`）。
- `key <sk-...>`：调用 `whale_config`（`action=set`，`apiKey=<值>`）写入 DeepSeek API Key。
- `mode ledger|token`：调用 `whale_config`（`action=set`，`usageMode=...`）切换用量统计模式。

若 MCP 工具不可用（例如插件刚装好还没重启会话），退回命令行：

```bash
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" status          # 或 turn / start / stop / url / json
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" window start    # 桌面浮层（浮在 ZCode 上）
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" desktop install # 首次使用浮层前安装 Electron 运行时
```

输出要求：中文，先给结论（服务/浮层是否正常、余额多少），再补充峰谷时段与数据来源。余额获取失败时，明确说出失败原因，并给出可执行的修复动作（配置 API Key 或检查网络），不要只贴原始错误；同时说明**这不影响方框**。用户问"为什么界面上看不到方框"时，说明 ZCode 客户端不提供界面注入点，所以用桌面浮层窗口实现，并给出 `window start` 或 `desktop install` 的确切命令。

