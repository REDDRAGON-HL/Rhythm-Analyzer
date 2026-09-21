/* =========================================================
   In Falsus 谱面格式支持（infalsus.js）

   使用https://github.com/REDDRAGON-HL/InFalsus-Resource 的JSON格式导出，暂不支持 .spc 源文件
   noteType 映射：tap / flick → 0；hold → 头 0 + 尾 2；field → 头 1 + 尾 2
   ========================================================= */
registerChartAdapter(
  "infalsus",
  raw => !!raw && typeof raw == "object" && raw.format === "ICP1" && Array.isArray(raw.notes),
  function (raw) {
    const TYPE_TAP = 0
    const TYPE_DRAG = 1
    const TYPE_HOLD_TAIL = 2
    const DENOM = 96
    // beat 由整数毫秒换算而来，每音带 ±0.001 拍噪声，相邻相减会顶破3e-3 容差
    // 吸附后间隔是1/96 整数倍
    const snapBeat = v => Math.round(v * DENOM) / DENOM

    // BPM 段表：头部 bpm 起，type 1 事件处切换
    const time = [{ beat: [0, 0, 1], bpm: (typeof raw.bpm == "number" && raw.bpm > 0) ? raw.bpm : 120 }]
    const evs = (Array.isArray(raw.events) ? raw.events : [])
      .filter(e => e && e.type === 1 && typeof e.bpm == "number" && e.bpm > 0 && typeof e.beat == "number")
      .sort((a, b) => a.timeMs - b.timeMs)
    for (const e of evs) {
      const total = Math.round(e.beat * DENOM)
      const seg = { beat: [Math.floor(total / DENOM), total % DENOM, DENOM], bpm: e.bpm }
      const last = time[time.length - 1]
      if (last && beatToVal(last.beat) === beatToVal(seg.beat)) { last.bpm = seg.bpm; continue }   // 同拍变速点只留最后一个
      time.push(seg)
    }

    // 每条记录 = 一个段
    const taps = []
    for (const n of raw.notes) {
      if (!n || typeof n.beat != "number") continue
      const col = (typeof n.lane == "number") ? n.lane : undefined
      const b0 = snapBeat(n.beat)
      const b1 = (typeof n.endBeat == "number") ? snapBeat(n.endBeat) : null
      const hasTail = b1 !== null && b1 > b0
      if (n.type === 5) {
        taps.push({ beatVal: b0, column: col, noteType: TYPE_DRAG })              // field
        if (hasTail) taps.push({ beatVal: b1, column: col, noteType: TYPE_HOLD_TAIL })
      } else if (n.type === 2) {
        taps.push({ beatVal: b0, column: col, noteType: TYPE_TAP })               // hold 头
        if (hasTail) taps.push({ beatVal: b1, column: col, noteType: TYPE_HOLD_TAIL })
      } else {
        taps.push({ beatVal: b0, column: col, noteType: TYPE_TAP })               // tap(1) / flick(4)
      }
    }

    return { time, taps, bgmOffsetSec: 0 }
  }
)
