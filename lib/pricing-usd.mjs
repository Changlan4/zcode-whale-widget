// 会话用量计价：美元 / 每百万 token，按北京时间分峰谷。
//
// 峰时：北京时间周一至周五 09:00–12:00 与 14:00–18:00；其余（含周末）谷时。
// 逐条调用按它自己的 started_at 判档，所以跨档的长会话金额是分档累加的。
//
// 计价口径的两个硬约束（改这里之前务必读）：
//   1. ZCode 的 input_tokens 是**含缓存命中的总输入**，未命中 = input - cache_read，
//      两部分必须分开计价。整份输入按未命中价算会虚高几十倍。
//   2. output_tokens **已包含** reasoning_tokens（实测 computed_total = input + output），
//      不能再把 reasoning 加一遍，否则输出部分重复计费。
export const USD_PRICES = {
  off_peak: { hit: 0.003, miss: 0.15, out: 0.6 },
  peak: { hit: 0.006, miss: 0.3, out: 1.2 },
}

export const PEAK_HOURS = [
  [9, 12],
  [14, 18],
]

const PER_MILLION = 1e6

function num(v) {
  const n = Number(v)
  return isFinite(n) ? n : 0
}

// epochMs 按北京时间取日历日与小时（+8h 后用 UTC 读取即是北京日历）
export function isPeak(epochMs) {
  const ms = Number(epochMs)
  if (!isFinite(ms) || ms <= 0) return false
  const bj = new Date(ms + 8 * 3600 * 1000)
  const dow = bj.getUTCDay() // 0=周日 6=周六
  if (dow === 0 || dow === 6) return false
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

export function priceAt(epochMs) {
  return isPeak(epochMs) ? USD_PRICES.peak : USD_PRICES.off_peak
}

// 一次模型调用的用量 → 分档 token 与金额
export function costOfCall(usage, atMs) {
  const input = num(usage && (usage.input !== undefined ? usage.input : usage.input_tokens))
  const cacheRead = num(usage && (usage.cacheRead !== undefined ? usage.cacheRead : usage.cache_read_input_tokens))
  const output = num(usage && (usage.output !== undefined ? usage.output : usage.output_tokens))
  const miss = Math.max(0, input - cacheRead)
  const peak = isPeak(atMs)
  const p = priceAt(atMs)
  const costHit = (cacheRead / PER_MILLION) * p.hit
  const costMiss = (miss / PER_MILLION) * p.miss
  const costOut = (output / PER_MILLION) * p.out
  return {
    input,
    peak,
    tier: peak ? 'peak' : 'off_peak',
    hit: cacheRead,
    miss,
    out: output,
    costHit,
    costMiss,
    costOut,
    cost: costHit + costMiss + costOut,
  }
}

export { PER_MILLION }
