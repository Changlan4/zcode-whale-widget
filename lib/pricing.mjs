// DeepSeek 峰谷定价与 token→金额 换算。
// 单价单位：元 / 百万 token，数组下标 0=空闲时段，1=高峰时段。
// 数据来源与算法沿用上游 dsh-whale-widget（MIT），并在 ZCode 版里补充
// deepseek-flash / deepseek-v4-pro 等模型名的宽松匹配。

// 高峰时段：工作日 9:00–12:00 与 14:00–18:00（北京时间）
export const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }

// 模型名 → 价目表。匹配方式是「模型名包含键名」，_default 为兜底。
export const PRICING = {
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
  _default: BASE_PRICE,
}

export function priceFor(model) {
  const m = String(model || '').toLowerCase()
  if (!m) return PRICING._default
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return PRICING[key]
  }
  // ZCode 里 provider 常把模型直接命名为 deepseek-flash / deepseek-pro：
  // 这些名字不含 v4 前缀，按「含 pro 走 pro 价，其余走基础价」兜底。
  if (m.indexOf('pro') !== -1) return PRO_PRICE
  return PRICING._default
}

// 2026-08-23 00:00（北京时间）起，周末全天按谷价。生效时刻之前的历史分桶
// 仍按旧规则计价，所以周末判定带生效分界。
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)

// timeSec 为 epoch 秒；按北京时间（UTC+8）判定高峰/谷时
export function isPeakTime(timeSec) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay() // bj 按 UTC 读取即为北京日历日；0=周日 6=周六
    if (dow === 0 || dow === 6) return false
  }
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

function num(v) {
  const n = Number(v)
  return isFinite(n) ? n : 0
}

// 从不同来源的 usage 结构里取出各类 token 计数。
// 兼容 ZCode 的 turn_usage 列名（snake_case）与模型返回的 camelCase 字段。
export function normalizeTokens(usage) {
  const u = usage || {}
  return {
    input: num(u.input_tokens !== undefined ? u.input_tokens : u.inputTokens),
    cacheRead: num(u.cache_read_input_tokens !== undefined ? u.cache_read_input_tokens : u.cacheReadTokens),
    cacheCreation: num(u.cache_creation_input_tokens !== undefined ? u.cache_creation_input_tokens : u.cacheWriteTokens),
    output: num(u.output_tokens !== undefined ? u.output_tokens : u.outputTokens),
    reasoning: num(u.reasoning_tokens !== undefined ? u.reasoning_tokens : u.reasoningTokens),
    total: num(
      u.computed_total_tokens !== undefined
        ? u.computed_total_tokens
        : u.total_tokens !== undefined
          ? u.total_tokens
          : u.totalTokens
    ),
  }
}

// 把「输入」拆成缓存命中与未命中两部分。
//
// 这两种口径的存在是个真实的坑：DeepSeek / OpenAI 风格里 input 是**总输入**，
// 已经包含缓存命中的部分（ZCode 实测 computed_total_tokens = input + output，
// 且 input >= cacheRead）；Anthropic 风格则是 input 不含缓存，总量要再加
// cacheRead + cacheCreation。若把 DeepSeek 的 input 整份按未命中价计价，缓存
// 那 99% 会被重复计费——实测同一轮会从 3.05 元虚高到 76.95 元。
export function splitInputTokens(t) {
  if (t.total > 0) {
    const asIncluded = Math.abs(t.total - (t.input + t.output + t.reasoning))
    const asExcluded = Math.abs(
      t.total - (t.input + t.cacheRead + t.cacheCreation + t.output + t.reasoning)
    )
    if (asExcluded < asIncluded) {
      // Anthropic 风格：input 只是「未缓存的新输入」
      return { hit: t.cacheRead, miss: t.input, cacheWrite: t.cacheCreation }
    }
  }
  // 默认（也是 ZCode + DeepSeek 的实测口径）：input 是总输入
  return {
    hit: t.cacheRead,
    miss: Math.max(0, t.input - t.cacheRead),
    cacheWrite: t.cacheCreation,
  }
}

// 按峰谷价换算一笔 usage 的金额。
// 分档：缓存读取→hit 价；未命中输入与缓存写入→miss 价；输出与思考→out 价。
export function costOfUsage(model, usage, atMs) {
  const t = normalizeTokens(usage)
  const p = priceFor(model)
  const peak = isPeakTime(Math.floor((isFinite(atMs) ? atMs : Date.now()) / 1000))
  const idx = peak ? 1 : 0
  const parts = splitInputTokens(t)
  const amount =
    (parts.hit / 1e6) * p.hit[idx] +
    (parts.miss / 1e6) * p.miss[idx] +
    (parts.cacheWrite / 1e6) * p.miss[idx] +
    ((t.output + t.reasoning) / 1e6) * p.out[idx]
  return {
    amount,
    tokens: parts.hit + parts.miss + parts.cacheWrite + t.output + t.reasoning,
    peak,
    tier: p === PRO_PRICE ? 'pro' : 'base',
    breakdown: { hit: parts.hit, miss: parts.miss, cacheWrite: parts.cacheWrite, output: t.output + t.reasoning },
  }
}
