# ZCode 会话用量方框

> 在 ZCode 界面上浮一个方框，实时显示**当前会话**自新建以来的累计用量：
>
> - **累计 token**：输入命中缓存 / 输入未命中 / 输出，三分
> - **累计花费**：对应上面三分，按峰谷单价换算成美元
> - **已用上下文**：最近一次请求占用了多少 / 上限 100 万
>
> 从会话列表点开另一个会话时，方框的数字**跟着切换**。它跟着 ZCode 窗口移动/最小化/关闭，指针不在方框上时点击直接穿透到下面的应用——**不挡任何操作**。

---

## 关于参考项目（请先读这一段）

**本项目是改造版，源于一个移植项目。** 早期形态是「DeepSeek 余额小鲸鱼挂件」，其视觉与交互设计、鲸鱼素材、音效、台词、峰谷定价表和计费口径来自：

| | |
|---|---|
| **项目** | [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) |
| **作者** | MeteorNOX |
| **许可** | MIT（Copyright (c) 2026 MeteorNOX） |
| **原始形态** | DSH（DeepSeek Harness）的 Web 插件 |

上游是挂在 **DSH 网页界面**右下角的鲸鱼挂件：由宿主插件通过 `webServer` 注册路由、用 `tapIndex` 把 `widget.js` 注入 DSH 页面，监听宿主进程内的 `session/event` 统计每轮消耗，从 DSH 凭据服务读 `DEEPSEEK_API_KEY`。

**ZCode 没有这些扩展点**（客户端不支持往界面注入脚本，插件也没有凭据服务、拿不到进程内事件流），所以宿主适配层是重写的。

### 当前形态：鲸鱼视觉层已移除

现在的方框**不再是鲸鱼**。视觉层（图片 `DSniang*.png`、动图 `rua.gif`、音效 `Ya*/D*`、气泡 SVG、按压动画、随机台词、菜单）已全部删除，改为一个朴素的方框面板。

**沿用自上游的部分**

- 峰谷定价**思想**与时段规则（工作日北京时间 9–12、14–18 为高峰，周末全天谷时）。
- 「缓存读取按命中价、未命中输入按未命中价、输出按输出价」的分档思路，以及 `input 含缓存命中` 这个关键口径。
- 记账模式语义（按观测到的余额下降累计、充值不扣减、币种切换只重置基准、跨天归档保留 30 天）。
- 余额接口的取项规则：多币种数组顺序不固定，优先 CNY 且大于 0；以及 25 秒缓存、in-flight 去重、瞬时失败回退旧值并标记 `stale`。

**为 ZCode 重写 / 新增**

- **方框用量面板**：`lib/session-usage.mjs`（会话判定 + 聚合）、`lib/box.js` + `lib/box-css.mjs`（渲染与交互）、`lib/pricing-usd.mjs`（美元峰谷价）。
- **呈现层**：上游注入 DSH 网页；这里改为自带本地服务 + 独立页面，并提供一个透明置顶的桌面浮层窗口。
- **凭据发现**：环境变量 → 插件配置 → 复用 ZCode 客户端里已配的 DeepSeek provider 三级查找。
- **每轮消耗数据源**：上游监听 `session/event`；这里读 ZCode 落库的 `turn_usage` 表（支持回退到模型 I/O 日志）。
- **平台集成**：MCP 服务、SessionStart 自启 hook、skill、`/whale` 命令、命令行工具。
- **安全加固**：出站主机白名单与地址校验、本地服务的 Host/Origin 校验与关闭令牌。

上游的 `LICENSE` 原样保留在本仓库中，另有 [`NOTICE`](./NOTICE)。

> 目录名、插件名、MCP 工具前缀仍叫 `zcode-whale-widget` / `whale_*`（改名要动插件注册与 MCP 工具前缀，没必要），但它们指向的已是方框。

---

## 功能

### 方框（主功能）

- **累计 token**，三分显示：输入命中缓存 / 输入未命中 / 输出。数字**全量显示**（超过一亿才缩写成「X.XX亿」）。
- **累计花费**，同样三分，附总计。单价按**峰谷**分档，逐条调用按它自己的时刻判档。
- **已用上下文**：最近一次主请求的输入总量 ÷ 100 万，带进度条。
- **跟随会话**：从会话列表点开另一个会话，标题与三个数字整体切换。
- 拖拽移动、贴边吸附、位置与字号记忆（`localStorage`）、每 5 秒刷新。
- 浮层下**默认鼠标穿透**：只有指针压在方框上时才接管鼠标。

### 保留的辅助能力（MCP / 命令行）

- **余额**：来自 `https://api.deepseek.com/user/balance`。
- **今日已用**，两种模式：**记账**（默认，免令牌，观测余额下降累计）与**实时·令牌**（需平台令牌）。
- **每轮对话消耗**：读 ZCode 记录的每轮真实 token 用量换算金额（`node lib/cli.mjs turn`）。

### 会话自启与窗口联动

- **会话自启**：打开 ZCode（新会话）时自动拉起服务与浮层。
- **随窗口联动**：ZCode 移动/缩放时跟着走，最小化或被别的应用盖住时隐藏，退出时一起退出。

---

## 统计口径

| 项目 | 算法 |
|---|---|
| 输入 · 命中缓存 | `sum(cache_read_input_tokens)` |
| 输入 · 未命中 | `sum(input_tokens) - sum(cache_read_input_tokens)` |
| 输出 | `sum(output_tokens)` |
| 已用上下文 | 最近一条 `main_turn` 的 `input_tokens`（含缓存命中，因为命中部分同样占窗口） |

**两个必须记住的坑**（改计价代码前务必读 `lib/pricing-usd.mjs` 的注释）：

1. ZCode 的 `input_tokens` 是**含缓存命中的总输入**，未命中必须减掉命中部分。否则缓存那 99% 会被按未命中价重复计费，金额虚高几十倍。
2. `output_tokens` **已包含** `reasoning_tokens`，输出只按 `output_tokens` 计，再加一遍就是重复收费。

**统计范围**：当前会话自新建以来，只算 `query_source='main_turn'` 的调用（自动生成标题的开销不计入）。子代理/工作流是独立会话，不并入主会话。

### 单价（美元 / 每百万 token）

| 项目 | 谷时 | 高峰 |
|---|---|---|
| 输入 · 命中缓存 | $0.003 | $0.006 |
| 输入 · 未命中 | $0.15 | $0.30 |
| 输出 | $0.60 | $1.20 |

高峰 = 北京时间**周一至周五 09:00–12:00 与 14:00–18:00**，其余（含周末）为谷时。改价目只改 `lib/pricing-usd.mjs` 的 `USD_PRICES`。

### 实时粒度

ZCode 在**每次模型请求完成时**才落库，没有「逐字滚动」的中间态。一轮对话里模型每完成一次内部请求（通常 10–25 次）数字跳一次，间隔几秒到几十秒。切换会话与上下文是即时的（前端每 5 秒轮询）。

---

## 当前会话是怎么确定的

ZCode 插件拿不到客户端 UI 事件。唯一能反映「用户正在看哪个会话」的可读信号是**客户端日志**：

```
<dataBaseDir>/.zcode/v2/logs/YYYY-MM-DD.log
  ...v4 session data lease acquired {"event":"v4.session_data.acquire","sessionId":"sess_...",...}
```

你每从会话列表点开一个会话，客户端就写一行。`lib/session-usage.mjs` 用**增量扫描**读它（记住上次偏移，只读新增部分）——不能只读文件尾部，因为客户端每分钟都写内存采样，一次 acquire 几百 KB 后就会被挤出尾部窗口。日志里读不到时才回退到「最近有调用的会话」（此时接口的 `sessionSource` 会是 `db` 而非 `log`，可用来判断）。

`dataBaseDir` 取自 `~/.zcode/v2/setting.json`。

---

## 两种显示方式

### 1. 桌面浮层（推荐）

一个独立的 Electron 窗口：透明、无边框、不进任务栏、始终置顶，**覆盖 ZCode 窗口范围但默认鼠标穿透**——只有指针压在方框上时才接管鼠标，其余位置的点击照常落到下面的 ZCode。

### 2. 网页版（零依赖）

服务本身就是个本地网页，浏览器打开地址即可看到同一个方框：

```
╭──────────────────────────────────────────╮
│ ● 理解 zcode-whale-widget 桌面安装步骤    │
│ ▎输入 · 命中缓存   27,872,768    $0.0836  │
│ ▎输入 · 未命中        400,651    $0.0601  │
│ ▎输出                375,342    $0.2252  │
│ ──────────────────────────────────────── │
│ 已用上下文   236,366 / 1,000,000 · 23.6% │
│ ▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
│ 合计 28,648,761 tokens · $0.3689 · 191次  │
╰──────────────────────────────────────────╯
```

两种方式共用同一个服务与同一份方框代码；浮层只是多了一个承载窗口。

---

## 安装

### 前置条件

- ZCode 客户端（插件系统）
- Node.js（用于运行插件自带的脚本）——ZCode 通常已自带，命令行里 `node -v` 能跑即可
- Windows（桌面浮层依赖 Win32 窗口 API；网页版跨平台）

### 步骤

1. 把仓库克隆到本地（例如 `E:\AI\ZCode\.zcode\plugins\zcode-whale-widget`）：

   ```bash
   git clone https://github.com/nb10yyds/zcode-whale-widget.git ~/.zcode/plugins/zcode-whale-widget
   ```

   后面的命令都假设你在仓库根目录下执行。

2. **注册为本地插件市场**，二选一：

   **方式 A：客户端界面**
   设置 → 插件管理 → **发现** → 右上角 `+` → 选择**本地目录**，指向仓库根目录（内含 `marketplace.json`）。

   **方式 B：手工写配置**
   在 `~/.zcode/cli/plugins/known_marketplaces.json` 的 `marketplaces` 数组里追加：

   ```json
   {
     "id": "zcode-whale-local",
     "source": { "source": "directory", "path": "<仓库绝对路径>" },
     "name": "zcode-whale-local",
     "description": "Local marketplace for the ZCode session usage box.",
     "pluginCount": 1
   }
   ```

3. **安装并启用插件**：在插件管理里安装 `zcode-whale-widget`。手工方式则在 `~/.zcode/cli/config.json` 里写：

   ```json
   {
     "plugins": {
       "enabledPlugins": {
         "zcode-whale-widget@zcode-whale-local": true
       }
     }
   }
   ```

4. **重启会话**（或重开 ZCode），让 MCP 服务与 hook 生效。

5. **想用桌面浮层的话，再装一次它的运行时**（约 150MB，一次性；只装到数据目录，不进仓库）：

   ```bash
   node lib/cli.mjs desktop install
   ```

装好后打开 ZCode，方框会自己出现。

> **重要：改代码后要同步到缓存。** 插件安装时会把仓库**复制**一份到
> `~/.zcode/cli/plugins/cache/zcode-whale-local/zcode-whale-widget/<版本>/`，
> MCP、hook、浮层全部跑缓存那份。改了 clone 里的代码必须同步过去（或重装插件）才生效。

---

## 首次配置

### API Key（余额功能用，方框不需要）

余额接口需要一个 DeepSeek API Key。按以下顺序自动查找，**大多数情况第一条或第三条就能命中，无需配置**：

1. 环境变量 `DEEPSEEK_API_KEY`
2. `~/.zcode/whale/config.json` 的 `apiKey`
3. ZCode 客户端里已配置的、`baseURL` 指向 `api.deepseek.com` 的 provider

如果三者都没有（例如你的 provider 用的是中转站），余额会显示「未找到 DeepSeek API Key」。**这完全不影响方框**——方框的数字全部来自本地数据库。

要配的话：

```bash
node lib/cli.mjs key sk-xxxx
```

### 常用命令

```bash
node lib/cli.mjs status           # 余额 + 今日已用 + 服务与浮层状态
node lib/cli.mjs turn             # 上一轮对话消耗
node lib/cli.mjs start / stop     # 启停服务
node lib/cli.mjs window start     # 启动桌面浮层（浮在 ZCode 界面上）
node lib/cli.mjs window stop      # 关闭浮层
node lib/cli.mjs window status    # 浮层与运行时状态
node lib/cli.mjs desktop install  # 安装 Electron 运行时（仅浮层需要，一次性）
node lib/cli.mjs key sk-...       # 写入 API Key
node lib/cli.mjs mode ledger|token  # 切换用量统计模式
node lib/cli.mjs json             # 结构化输出，便于脚本消费
```

### 在对话里直接用

- 输入 `/whale`（或 `/whale turn`、`/whale window start`、`/whale key sk-...`）
- 或者直接问「我还有多少余额」「上一轮花了多少」，ZCode 会调用 MCP 工具：

| MCP 工具 | 作用 |
|---|---|
| `whale_balance` | 余额 + 今日已用 + 峰谷时段 |
| `whale_last_turn` | 上一轮对话消耗 |
| `whale_widget` | 启停服务与浮层、查状态 |
| `whale_config` | 改 API Key、用量模式、自启、端口 |

> 方框本身在会话里没有对应的 MCP 工具——它是常驻桌面面板，直接看即可。

### 方框自己的设置

拖拽移动、贴边吸附自动保存。字号用 `Ctrl/Alt + 滚轮` 调整，双击刷新。这些存在浏览器 localStorage（键 `zcw-box-pos` / `zcw-box-view`）。

### 自启

`~/.zcode/whale/config.json`：

| 字段 | 含义 |
|---|---|
| `autoStartWidget` | 默认 `true`，会话启动时自动拉起服务 |
| `autoStartOverlay` | 默认 `true`，会话启动时顺带拉起浮层（运行时没装则静默跳过） |
| `port` | 固定端口，留空用默认 39321，占用时自动顺延 |
| `followIntervalMs` | 跟随探测间隔（毫秒），默认 40 |

关掉自启就把对应字段设为 `false`。

---

## 数据来源

- **会话用量**：ZCode 的 `~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表（**只读直连**；库被 WAL 模式占用但只读打开可用，无需复制）。
- **每轮消耗**：同库的 `turn_usage` 表。
- **当前会话**：`<dataBaseDir>/.zcode/v2/logs/*.log` 里的 `v4.session_data.acquire`。
- **余额**：`https://api.deepseek.com/user/balance`。

---

## 开发

```bash
node tools/selftest.mjs       # 端到端自检（临时 ZCODE_HOME，不碰真实数据，23 项断言）
node tools/demo.mjs           # 演示：起假服务，6 秒加一次调用、30 秒切一次会话
node tools/debug-overlay.mjs  # 浮层诊断（需 WHALE_DEBUG_PORT=9333 启动浮层）
```

`tools/selftest.mjs` 覆盖了会话判定、分会话聚合、缓存不重复计费、输出不含 reasoning、峰谷分档、切换会话跟随、令牌关闭等。**改动计价或会话判定逻辑后必须跑一遍。**

---

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| 界面上看不到方框 | 必须走桌面浮层：`desktop install` 装运行时，再 `window start` |
| 打开 ZCode 没有自动出现 | 看 `~/.zcode/whale/autostart.log` 最后一行。没有新行说明 hook 没加载（插件未启用，或改完配置后没重启会话）；`overlay=skipped:no-runtime` 说明运行时没装 |
| **切换会话后数字不变** | 查接口的 `sessionSource`：`db` 表示没读到日志事件、走了回退。检查客户端日志目录与 `v4.session_data.acquire` 行是否存在 |
| 数字一直不更新 | 前端每 5 秒轮询。确认当前会话有新调用；失败时方框底部显示「取数失败，重试中…」 |
| 余额显示「未找到 DeepSeek API Key」 | 三条凭据来源都没命中。用 `key` 子命令写入。与方框无关 |
| 余额显示旧值并带 `stale` | 接口瞬时失败，服务在回退缓存。4xx 不会回退 |
| 今日已用一直是 0 | 记账模式只统计观测到的余额下降：还没消费，或消耗发生在服务未运行时 |
| **花费虚高十几倍** | 计价口径踩了「input 含缓存」，或把 reasoning 又加了一遍。核对 `lib/pricing-usd.mjs` 并跑 `node tools/selftest.mjs` |
| 方框不跟着 ZCode 走 | 跟随由 `desktop/follow-window.ps1` 常驻探测；`window stop` 后 `window start` 重建 |
| 浮层点不动方框 | 默认鼠标穿透，指针要先停在方框上。诊断：`WHALE_DEBUG_PORT=9333 node lib/cli.mjs window start` 后跑 `node tools/debug-overlay.mjs` |
| 浮层启动失败 | `window status` 看运行时是否已装 |
| **`window start` 报服务未就绪但服务在跑** | 服务身份名不一致：`lib/paths.mjs` 的 `APP_ID` 必须与健康接口返回的 `app` 相同 |
| 改了源码不生效 | 插件跑的是缓存副本，见上文「重要：改代码后要同步到缓存」 |
| 峰谷判定不对 | 方框看 `lib/pricing-usd.mjs`，余额/每轮看 `lib/pricing.mjs`；高峰为北京时间工作日 9–12、14–18 |

---

## 卸载

1. 在插件管理里禁用/卸载 `zcode-whale-widget`
2. 删掉数据目录 `~/.zcode/whale/`（配置、账本、桌面运行时都在里面）
3. 如需彻底清理，删掉 clone 目录与 `~/.zcode/cli/plugins/cache/zcode-whale-local/`
