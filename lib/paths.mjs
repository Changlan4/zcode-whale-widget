// 插件内的所有路径解析。集中在这里，方便迁移与调试。
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// lib/paths.mjs -> 插件根目录
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const ZCODE_HOME = process.env.ZCODE_HOME || path.join(os.homedir(), '.zcode')

// 插件自己的数据目录：配置、账本、挂件状态、运行信息都写这里
export const DATA_DIR = path.join(ZCODE_HOME, 'whale')

// 用户配置（apiKey / platformToken / port / usageMode 等）
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json')
// 挂件外观与开关（等价于上游的 .dshw-size.json）
export const WIDGET_STATE_FILE = path.join(DATA_DIR, 'widget-state.json')
// 记账模式账本（等价于上游的 .dshw-usage.json）
export const LEDGER_FILE = path.join(DATA_DIR, 'usage-ledger.json')
// 挂件服务运行信息（pid / port / url），供命令与 MCP 复用同一个服务
export const SERVER_INFO_FILE = path.join(DATA_DIR, 'server.json')

// ZCode 的会话数据库：turn_usage / model_usage 表提供每轮真实 token 用量
export const DB_FILE = path.join(ZCODE_HOME, 'cli', 'db', 'db.sqlite')
// 模型 I/O 日志目录：读不到数据库时的兜底数据源
export const ROLLOUT_DIR = path.join(ZCODE_HOME, 'cli', 'rollout')
// ZCode 客户端配置：用于发现用户已经配好的 DeepSeek provider 凭据
export const ZCODE_CLIENT_CONFIG = path.join(ZCODE_HOME, 'v2', 'config.json')

// 客户端日志目录：里面记着「用户打开了哪个会话」（v4.session_data.acquire），
// 是判断当前会话的唯一可读信号。实际目录见 session-usage.mjs（要走 dataBaseDir）。
export const CLIENT_LOG_DIR = path.join(ZCODE_HOME, 'v2', 'logs')

export const DEFAULT_PORT = 39321

// 服务身份标识：健康检查与探活校验共用，改这里即可，别再各写一份字面量
// （曾经因为 server 与 service 写了两套名字，导致服务起得来但探活永远不通过）。
export const APP_ID = 'zcode-session-usage-box'
