---
name: zcode-whale-widget
description: 操作与排查 ZCode 会话用量方框（原 DeepSeek 余额小鲸鱼挂件改造而来，插件名沿用）。适用于：查看当前会话自新建以来的累计 token（缓存命中/未命中/输出三分）、累计花费、已用上下文；把方框作为桌面浮层显示在 ZCode 界面之上（安装 Electron 运行时、浮层点不动或不显示、浮层关闭）；查询 DeepSeek 账户余额、今日已用金额、当前峰谷时段或上一轮对话消耗；配置 DeepSeek API Key、用量统计模式、端口或会话自启；以及切换会话后方框数字不跟着变、上下文或花费不对、余额获取失败、峰谷判定不对等问题。
---

# ZCode 会话用量方框

**当前形态**：一个显示「当前会话累计用量」的桌面方框（token 三分 / 花费 / 已用上下文），浮在 ZCode 界面之上，切换会话时数字跟着变。它由 DSH 版鲸鱼挂件（[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)，MIT）改造而来：鲸鱼的视觉层（图片/音效/动画/气泡）已全部移除，余额与「每轮消耗」能力保留在 MCP 与命令行里。插件与技能的**目录名仍叫 `zcode-whale-widget`**（改名要动插件注册与 MCP 工具前缀，没必要），但内容已是方框。

## 架构（先读这段再动手排查）

| 组件 | 文件 | 职责 |
|---|---|---|
| 本地服务 | `lib/server.mjs` | 本地 HTTP 服务（默认 `127.0.0.1:39321`），提供方框页面与 JSON 接口 |
| 方框前端 | `lib/box.js` + `lib/box-css.mjs` | 拖拽、吸附、位置记忆、浮层鼠标穿透切换、5 秒轮询取数 |
| 会话用量 | `lib/session-usage.mjs` | 定「当前会话」（读客户端日志）+ 聚合数据库 + 组装快照 |
| 计价 | `lib/pricing-usd.mjs` | 美元峰谷单价与 token→金额换算（方框改价目只改这里） |
| 桌面浮层 | `desktop/main.cjs`、`desktop/preload.cjs` | 透明置顶无边框窗口承载方框，默认鼠标穿透，只加载本机 127.0.0.1 |
| 浮层管理 | `lib/overlay.mjs` | 浮层单例检查、启停，以及 Electron 运行时的按需安装 |
| 余额与账本 | `lib/balance.mjs` | 拉余额、记账模式累计、平台用量换算、25 秒缓存与瞬时失败回退 |
| 每轮消耗 | `lib/turn-cost.mjs` | 读 ZCode 的 `turn_usage` 表，换算每轮金额 |
| 凭据与出站校验 | `lib/credentials.mjs` | 找 API Key、出站主机白名单校验 |
| MCP 工具 | `lib/mcp-server.mjs` | 会话内查询余额/每轮消耗、启停服务与浮层、改配置 |
| 命令行 | `lib/cli.mjs` | `status` / `turn` / `start` / `stop` / `window` / `desktop install` / `key` / `mode` / `json` |
| 会话自启 | `lib/autostart.mjs` | SessionStart hook 幂等拉起服务（以及已装运行时的浮层） |

**ZCode 客户端不提供界面注入点**（插件清单里没有 view/panel/webview 之类字段），所以方框有两种呈现方式，排查时先确认用户指的是哪一种：

1. **桌面浮层**：独立的 Electron 透明置顶窗口，覆盖整个工作区但默认鼠标穿透，指针压到方框上时才接管鼠标。这是「浮在 ZCode 界面上」的实现方式。
2. **网页版**：浏览器打开 `http://127.0.0.1:<port>/`，零依赖。

两者共用同一个服务与同一份 `lib/box.js`；`box.js` 通过 preload 暴露的 `window.whaleDesktop` 判断自己是否跑在浮层里，跑在普通浏览器里时穿透逻辑自动失效。

## 方框显示什么

| 行 | 含义 | 算法 |
|---|---|---|
| 输入 · 命中缓存 | 累计命中的输入 token 与花费 | `sum(cache_read_input_tokens)` |
| 输入 · 未命中 | 累计未命中的输入 token 与花费 | `sum(input_tokens) - sum(cache_read_input_tokens)` |
| 输出 | 累计输出 token 与花费 | `sum(output_tokens)` |
| 已用上下文 | 最近一次主请求的输入总量 / 100 万 | 最后一条 `main_turn` 的 `input_tokens` |

- **统计范围**：当前会话**自新建以来**的累计，只算 `query_source='main_turn'` 的调用（自动生成标题的开销不计入）。
- **token 全量显示**，超过一亿才缩写成「X.XX亿」（用户明确要求，别改回 128K 这种）。
- **单价（美元 / 每百万 token）**：谷时 命中 $0.003 / 未命中 $0.15 / 输出 $0.60；高峰 $0.006 / $0.30 / $1.20。高峰 = 北京时间周一至周五 09:00–12:00 与 14:00–18:00，其余（含周末）为谷时；**逐条调用按它自己的 `started_at` 判档**。
- **上下文分母固定 100 万**（`CONTEXT_LIMIT`），与 ZCode 给 deepseek 系列配置的 `contextWindow` 一致。

## 当前会话是怎么确定的（核心机制）

ZCode 插件拿不到 UI 事件，**唯一能反映「用户正在看哪个会话」的可读信号是客户端日志**：

```
<dataBaseDir>/.zcode/v2/logs/YYYY-MM-DD.log
  ...v4 session data lease acquired {"event":"v4.session_data.acquire","sessionId":"sess_...",...}
```

用户每从会话列表点开一个会话就会写一行。`session-usage.mjs` 用**增量扫描**读它（记住上次偏移，只读新增部分），而不是只读文件尾部——客户端每分钟都写内存采样等噪音，一次 acquire 几百 KB 后就会被挤出尾部窗口（实测切完半小时就落到 35 万字节之外，只读尾部必然读不到）。日志里读不到时才回退到「最近有调用的会话」。

`dataBaseDir` 来自 `~/.zcode/v2/setting.json`（本机是 `E:\AI\ZCode`），实际日志在它下面的 `.zcode/v2/logs`。**不要按日期拼文件名**：客户端按本地日期命名，用 UTC 日期拼会在北京时间 00:00–08:00 之间读错文件；代码里直接取目录中最新的 `.log`。

## 数据从哪来

- **会话用量与上下文**：`~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表，**只读直连**（库被 ZCode 以 WAL 模式占用，但只读打开实测可用，不需要先复制一份）。
- **每轮对话消耗**：同一库的 `turn_usage` 表。数据库读不到时回退解析 `~/.zcode/cli/rollout/model-io-*.jsonl`。
- **余额**：`GET https://api.deepseek.com/user/balance`，从 `balance_infos` 里优先选 CNY 且大于 0 的项（多币种数组顺序不固定，不能取 `[0]`）。
- **今日已用（记账模式，默认）**：每次观测余额，余额下降的差值累加进账本（`~/.zcode/whale/usage-ledger.json`）。**ZCode 关闭期间的消耗会漏记**。
- **今日已用（实时·令牌）**：需要 `DEEPSEEK_PLATFORM_TOKEN`，调平台用量接口拿 token 分桶，按峰谷定价自行换算。

### 计价口径的两个坑（改这段代码前务必读）

1. **`input_tokens` 是含缓存命中的总输入**（实测 `computed_total_tokens = input + output` 且 `input ≥ cache_read`，DeepSeek/OpenAI 风格）。未命中 = `input - cache_read`，两部分必须分开计价，否则缓存那 99% 会被按未命中价重复计费（实测虚高 25 倍）。
2. **`output_tokens` 已包含 `reasoning_tokens`**（20 条样本实测 20/20 成立）。输出部分**只按 `output_tokens` 计**，再把 reasoning 加一遍就是重复收费。

`tools/selftest.mjs` 对这两条都有回归断言（针对 `pricing-usd.mjs` 的 `costOfCall`），改动计价逻辑后必须跑一遍。

### 实时粒度

ZCode 是**每次模型请求完成时**才往库里写一行，不存在「逐字滚动」或「正在生成中」的中间态（实测 100 秒轮询从未见到 `status=running`）。一轮对话里模型每完成一次内部请求（通常 10–25 次）数字跳一次，间隔几秒到几十秒。切换会话与上下文是及时的（前端每 5 秒轮询）。

## 凭据优先级

1. 环境变量 `DEEPSEEK_API_KEY`
2. `~/.zcode/whale/config.json` 的 `apiKey`
3. **ZCode 客户端里已配置的 DeepSeek provider**（provider 的 `baseURL` 指向 `api.deepseek.com` 时复用其 key）

第 3 条是 ZCode 版的关键适配：上游从 DSH 凭据服务读 key，ZCode 没有等价服务，但用户可能已经配好了 DeepSeek 接入点。密钥只在内存中使用、只发往白名单主机，不落盘日志、不打印明文（对外只给 `sk-04…994` 这类掩码）。

> 注意：如果用户的 provider 是中转站（baseURL 不是 `api.deepseek.com`），第 3 条不会命中，余额会显示「未找到 DeepSeek API Key」。**这不影响方框**——方框的数字全部来自本地数据库，与余额接口无关。

## 常用操作

优先用 MCP 工具（`whale_balance`、`whale_widget`、`whale_last_turn`、`whale_config`），MCP 不可用时用命令行：

```bash
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" status          # 余额 + 今日已用 + 服务与浮层状态
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" turn            # 上一轮对话消耗
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" start           # 启动服务（返回地址）
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" stop            # 停止服务
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" json            # 结构化输出，便于程序消费
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" key sk-xxxx     # 写入 API Key
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" mode token      # 切换用量统计模式
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" window start    # 桌面浮层（浮在 ZCode 界面上）
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" window stop     # 关闭浮层
node "${ZCODE_PLUGIN_ROOT}/lib/cli.mjs" desktop install # 安装 Electron 运行时（浮层前置，一次性）
```

服务接口（排查时可直接 curl）：`/whale/health`、`/whale/session-usage.json`、`/whale/box.js`、`/whale/balance.json`、`/whale/last-turn.json`、`/whale/size.json`（GET/PUT）。

## 配置字段（`~/.zcode/whale/config.json`）

| 字段 | 含义 |
|---|---|
| `apiKey` | DeepSeek API Key |
| `platformToken` | 平台会话令牌（实时·令牌模式用） |
| `usageMode` | `ledger`（默认）或 `token` |
| `port` | 固定端口，留空则用默认 39321，占用时自动顺延 |
| `autoStartWidget` | 默认 `true`，SessionStart 是否自动拉起服务 |
| `autoStartOverlay` | 默认 `true`，会话启动时是否顺带拉起桌面浮层（Electron 运行时未安装时静默跳过） |
| `followIntervalMs` | 跟随探测间隔（毫秒），默认 40 |

方框自身的外观（字号、位置）存在浏览器 localStorage（键 `zcw-box-pos` / `zcw-box-view`），不在配置文件里。

## 故障排查

| 现象 | 原因与动作 |
|---|---|
| **界面上看不到方框** | 插件无法注入 ZCode 客户端界面，必须走桌面浮层：先 `desktop install` 装运行时，再 `window start`。装好后会话启动会自动拉起 |
| **切换会话后方框数字不变** | 先 `curl 127.0.0.1:<port>/whale/session-usage.json` 看 `sessionSource`：`log` 表示从日志读到了会话、`db` 表示走了回退（说明没读到 acquire 事件，方框会停在最近有调用的会话）。`db` 时检查客户端日志目录是否可读（`setting.json` 的 `dataBaseDir` → `.zcode/v2/logs`）、当天是否有 `v4.session_data.acquire` 行 |
| **打开 ZCode 没有自动出现方框** | 自启由 SessionStart hook（`lib/autostart.mjs`）负责，看 `~/.zcode/whale/autostart.log` 最后一行：`server=... overlay=...`。没有新行说明 hook 没被加载（插件未启用，或改完配置后还没重启会话）；`overlay=skipped:no-runtime` 说明 Electron 运行时没装；`overlay=failed:...` 看括号里的原因。也可直接 `node lib/autostart.mjs` 手动验证 |
| **数字一直不更新** | 前端每 5 秒轮询一次。若长时间不变，先确认当前会话确实有新调用（切到别的会话再切回来应立刻变）。取数失败时方框底部会显示「取数失败，重试中…」 |
| **上下文百分比不对** | 它取最近一次 `main_turn` 的 `input_tokens`（**含缓存命中**，因为命中部分同样占窗口）÷ 100 万。想换分母改 `session-usage.mjs` 的 `CONTEXT_LIMIT` |
| **花费与预期不符** | 逐条按各自 `started_at` 判峰谷。核对 `lib/pricing-usd.mjs` 的 `USD_PRICES` / `PEAK_HOURS`，并跑 `node tools/selftest.mjs`（含「缓存不重复计费」「输出不含 reasoning」「高峰为谷时两倍」等断言） |
| **方框不跟着 ZCode 走** | 跟随由 `desktop/follow-window.ps1` 常驻探测（默认每 40ms 读一次 ZCode 主窗口矩形与前台状态）。完全不动时先确认该 PowerShell 子进程是否还活着（`window stop` 后 `window start` 重建）；诊断信息写进 `~/.zcode/whale/overlay-debug.log`（仅在 `WHALE_DEBUG_PORT` 开启时记录） |
| 探测脚本秒退 / 浮层跟着消失 | 多为 `follow-window.ps1` 里的 C# 编译失败或脚本被写成非 ASCII。`overlay-debug.log` 里搜 `csharp-compile-failed` / `follow-loop-error`；**该文件必须保持纯 ASCII**（PS 5.1 按 ANSI 代码页读） |
| 方框位置错乱 / 跑到窗口外 | 透明窗口的合成层错位，通常是有人重新打开了定位过渡或改回 `setBounds` 贴窗口。见 README「与上游的差异」里的两条踩坑记录 |
| **浮层起来了但点不动方框** | 浮层默认鼠标穿透，指针必须先停在方框上才能点（光标变 `grab`）。若整块区域都点不动，检查是否被其它置顶窗口压住。诊断：`WHALE_DEBUG_PORT=9333 node lib/cli.mjs window start` 后跑 `node tools/debug-overlay.mjs`，并 `grep interactive ~/.zcode/whale/overlay-debug.log` |
| 浮层启动失败 | `node lib/cli.mjs window status` 看运行时是否已安装；未安装则 `desktop install`。Electron 约 150MB（解压后约 380MB），装到 `~/.zcode/whale/desktop-runtime` |
| **`window start` 报「服务未就绪」但服务明明在跑** | 服务身份名不一致：`lib/paths.mjs` 的 `APP_ID` 必须与 `server.mjs` 健康接口返回的 `app` 完全一致（`service.mjs` 的 `probeHealth` 按它校验）。历史上 server 与 service 各写一份名字字面量，导致服务起得来但探活永远失败 |
| **改了源码不生效** | 插件实际加载的是**缓存副本** `~/.zcode/cli/plugins/cache/zcode-whale-local/zcode-whale-widget/<版本>/`，改 clone 里的代码后必须把改动同步过去（或重装插件）。浮层的 Electron 入口也在这个缓存目录下的 `desktop/` |
| 改完 follow-window.ps1 后行为没变 | 该脚本是常驻子进程，改完要 `window stop` + `window start` 才会重新加载 |
| 余额显示「未找到 DeepSeek API Key」 | 三条凭据来源都没命中（常见于用中转站做 provider）。用 `key` 子命令写入即可；**与方框无关** |
| 余额显示旧值并带 `stale` | 接口瞬时失败（网络/5xx），服务在回退缓存。4xx 不会回退，会直接报错 |
| 今日已用一直 0 | 记账模式只统计「观测到的余额下降」：还没产生消费，或期间的消耗发生在服务未运行时。要精确数字改用 `mode token` |
| **每轮消耗金额离谱（虚高十几倍）** | 计价口径又踩了「input 含缓存」这个坑。核对 `lib/pricing.mjs` 的 `splitInputTokens()` 是否被 `costOfUsage()` 使用，并跑 `node tools/selftest.mjs`。用 `node lib/cli.mjs turn` 看逐档明细即可判断 |
| 挂件服务打不开 | `node lib/cli.mjs status` 看是否运行；未运行则 `start`。端口被占用会自动顺延，以 `status` 输出的地址为准 |
| 峰谷判定不对 | 方框用美元价，看 `lib/pricing-usd.mjs` 的 `PEAK_HOURS`；余额与每轮消耗用人民币价，看 `lib/pricing.mjs` 的 `PEAK_HOURS`。两处都是北京时间工作日上午 9–12、下午 14–18 |

排查浮层联动时有个前提：`desktop/follow-window.ps1` **必须保持纯 ASCII**。Windows PowerShell 5.1 会用系统 ANSI 代码页读取无 BOM 的 .ps1，中文注释会被解码成破坏语法的字节，脚本会直接退出（表现为跟随失效）。

## 出站安全约束

服务端只向白名单主机发请求（`api.deepseek.com`、`platform.deepseek.com`），发请求前校验协议为 http/https、主机名匹配白名单、拒绝环回/私有/保留地址的字面量 IP。改 `lib/credentials.mjs` 的 `ALLOWED_HOSTS` 才能扩展目标。

本地服务本身还有三层防护：只监听 `127.0.0.1`、校验 `Host` 头防 DNS rebinding、写操作校验 `Origin` 防跨站伪造；停止服务需要 `~/.zcode/whale/server.json` 里的随机令牌。

## 想改方框本身

- 视觉与布局在 `lib/box-css.mjs`（样式）+ `lib/box.js`（逻辑），改样式只动 css 那个文件即可。
- `lib/box.js` 里 localStorage 键是 `zcw-box-pos`（位置）与 `zcw-box-view`（字号）；容器 id 为 `#box`；路由前缀 `/whale/`。
- 取数与统计口径在 `lib/session-usage.mjs`（会话判定、聚合、上下文）；单价与峰谷在 `lib/pricing-usd.mjs`。
- 自检：`node tools/selftest.mjs`（临时 ZCODE_HOME，不碰真实数据，23 项断言）。
- 人工演示：`node tools/demo.mjs`（开假服务，6 秒加一次调用、30 秒切一次会话，浏览器里看效果）。
