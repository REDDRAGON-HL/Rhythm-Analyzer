/* =========================================================
   In Falsus 谱面格式支持（infalsus.js）

   使用https://github.com/REDDRAGON-HL/InFalsus-Resource 的JSON格式导出，暂不支持 .spc 源文件
   网格速度段表 = type 1（BPM）+ type 2（track speed）；拍值由 timeMs 反算
   拍号 = type 1 载荷 2，输出为 meters（载入时自动套用）
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
    // 拍值吸附网格
    const QUANTA = [96, 48, 24, 12, 6]
    const quantumForBpm = bpm => {
      for (const q of QUANTA) if (0.5 / q >= bpm / 60000) return q
      return QUANTA[QUANTA.length - 1]
    }
    const snapBeat = (v, q) => Math.round(v * q) / q

    // 网格速度段表
    const headBpm = (typeof raw.bpm == "number" && raw.bpm > 0) ? raw.bpm : 120
    const speedEvs = []
    let hasTrackSpeed = false
    for (const e of (Array.isArray(raw.events) ? raw.events : [])) {
      if (!e || typeof e.timeMs != "number") continue
      if (e.type === 1 && typeof e.bpm == "number" && e.bpm > 0) speedEvs.push({ ms: e.timeMs, bpm: e.bpm })
      else if (e.type === 2 && typeof e.gridSpeed == "number" && e.gridSpeed > 0) { speedEvs.push({ ms: e.timeMs, bpm: e.gridSpeed }); hasTrackSpeed = true }
    }
    speedEvs.sort((a, b) => a.ms - b.ms)
    const segs = [{ ms: 0, bpm: headBpm, beat: 0 }]
    for (const e of speedEvs) {
      const last = segs[segs.length - 1]
      if (e.ms <= last.ms) { last.bpm = e.bpm; continue }
      segs.push({ ms: e.ms, bpm: e.bpm, beat: 0 })
    }
    // 逐段积分
    for (let i = 1; i < segs.length; i++) {
      const rawStep = (segs[i].ms - segs[i - 1].ms) * segs[i - 1].bpm / 60000
      const step = hasTrackSpeed ? Math.max(0.25, Math.round(rawStep / 0.25) * 0.25) : rawStep
      segs[i].beat = segs[i - 1].beat + step
    }
    const time = segs.map(s => {
      const total = Math.round(s.beat * DENOM)
      return { beat: [Math.floor(total / DENOM), total % DENOM, DENOM], bpm: s.bpm }
    })
    const segAtMs = ms => {
      let lo = 0, hi = segs.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (segs[mid].ms <= ms) lo = mid
        else hi = mid - 1
      }
      return segs[lo]
    }
    const beatAtMs = ms => {
      const s = segAtMs(ms)
      return s.beat + (ms - s.ms) * s.bpm / 60000
    }
    const quantumAtMs = ms => quantumForBpm(segAtMs(ms).bpm)
    const pickBeat = (ms, jsonBeat) => {
      if (typeof ms != "number") return jsonBeat
      const grid = beatAtMs(ms)
      return (typeof jsonBeat == "number" && Math.abs(grid - jsonBeat) < 0.01) ? jsonBeat : grid
    }

    const meterEvs = []
    for (const e of (Array.isArray(raw.events) ? raw.events : [])) {
      if (!e || e.type !== 1 || typeof e.timeMs != "number") continue
      if (typeof e.meter != "number" || !(e.meter > 0)) continue
      meterEvs.push({ ms: e.timeMs, num: e.meter })
    }
    meterEvs.sort((a, b) => a.ms - b.ms)
    const meters = []
    for (const m of meterEvs) {
      const beat = snapBeat(beatAtMs(m.ms), quantumAtMs(m.ms))
      const last = meters[meters.length - 1]
      if (last && Math.abs(last.num - m.num) < 1e-9) continue
      if (last && Math.abs(last.beat - beat) < 1e-9) { last.num = m.num; continue }
      meters.push({ beat: beat, num: m.num, den: 4 })
    }

    // 每条记录 = 一个段
    const taps = []
    const fieldSegs = []
    for (const n of raw.notes) {
      if (!n) continue
      const col = (typeof n.lane == "number") ? n.lane : undefined
      const b0raw = pickBeat(n.timeMs, n.beat)
      if (typeof b0raw != "number") continue
      const q = (typeof n.timeMs == "number") ? quantumAtMs(n.timeMs) : DENOM
      const b0 = snapBeat(b0raw, q)
      const b1raw = pickBeat(n.endMs, n.endBeat)
      const b1 = (typeof b1raw == "number") ? snapBeat(b1raw, q) : null
      const hasTail = b1 !== null && b1 > b0
      if (n.type === 5) {
        const headIdx = taps.length
        taps.push({ beatVal: b0, column: col, noteType: TYPE_DRAG, chainId: n.line })
        const tailIdx = hasTail ? taps.length : null
        if (hasTail) taps.push({ beatVal: b1, column: col, noteType: TYPE_HOLD_TAIL, chainId: n.line })
        fieldSegs.push({ line: n.line, headIdx: headIdx, tailIdx: tailIdx })
      } else if (n.type === 2) {
        taps.push({ beatVal: b0, column: col, noteType: TYPE_TAP })               // hold 头
        if (hasTail) taps.push({ beatVal: b1, column: col, noteType: TYPE_HOLD_TAIL })
      } else {
        taps.push({ beatVal: b0, column: col, noteType: TYPE_TAP })               // tap(1) / flick(4)
      }
    }


    // 同一条 field 线上的多段：只保留该线第一个段头
    for (let i = 0; i < fieldSegs.length; i++) {
      const cur = fieldSegs[i], prev = fieldSegs[i - 1], next = fieldSegs[i + 1]
      const sameAsPrev = !!(prev && prev.line === cur.line)
      const sameAsNext = !!(next && next.line === cur.line)
      if (!sameAsPrev && !sameAsNext) continue
      if (sameAsPrev) taps[cur.headIdx].chainInner = true
      if (cur.tailIdx != null) taps[cur.tailIdx].chainInner = true
    }

    return { time, taps, meters, bgmOffsetSec: 0 }
  }
)
