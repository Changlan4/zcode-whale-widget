// 方框页面的样式与骨架（与 box.js 配套）。
// 单独放在 .css 里而不是内联，是为了让 box.js 保持纯逻辑、样式可单独调。

export function boxCss() {
  return `
#box {
  position: fixed;
  box-sizing: border-box;
  padding: 10px 12px 8px;
  border-radius: 10px;
  background: rgba(22, 24, 30, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.10);
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.42);
  color: #e8e8ea;
  font-family: "Microsoft YaHei UI", "Microsoft YaHei", system-ui, -apple-system, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  user-select: none;
  cursor: default;
}

#box .head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 7px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.09);
}
#box .dot {
  flex: 0 0 auto;
  width: 7px; height: 7px;
  border-radius: 50%;
  background: #6cc4a8;
  box-shadow: 0 0 6px rgba(108, 196, 168, 0.7);
}
#box .dot.peak { background: #e0af68; box-shadow: 0 0 6px rgba(224, 175, 104, 0.7); }
#box .dot.bad { background: #f07178; box-shadow: 0 0 6px rgba(240, 113, 120, 0.7); }
#box .title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 1em;
  font-weight: 600;
  color: #f2f2f4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

#box .row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 0;
}
#box .swatch {
  flex: 0 0 auto;
  width: 3px; height: 12px;
  border-radius: 2px;
  opacity: 0.9;
}
#box .row .label {
  flex: 1 1 auto;
  min-width: 0;
  color: #9a9aa4;
  font-size: 0.9em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#box .row .tok {
  flex: 0 0 auto;
  color: #e8e8ea;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
  text-align: right;
}
#box .row .cost {
  flex: 0 0 auto;
  min-width: 5.4em;
  color: #cdd0d8;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
  text-align: right;
}

#box .ctx {
  margin-top: 8px;
  padding-top: 7px;
  border-top: 1px solid rgba(255, 255, 255, 0.09);
}
#box .ctxline {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
#box .ctxlabel { color: #9a9aa4; font-size: 0.9em; }
#box .ctxval {
  color: #e8e8ea;
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
}
#box .ctxbar {
  position: relative;
  height: 4px;
  margin-top: 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.10);
  overflow: hidden;
}
#box .ctxbar i {
  display: block;
  width: 0;
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, #6cc4a8, #7aa2f7);
  transition: width 0.35s ease;
}

#box .foot {
  margin-top: 7px;
  color: #7d7d87;
  font-size: 0.85em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
`
}
