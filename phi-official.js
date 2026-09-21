/* =========================================================
   Phigros 官方谱 JSON 格式支持（phi-official.js）
   根对象有 formatVersion（1 或 3）+ offset + judgeLineList

   时间模型：
    time / holdTime 的整数单位 = 1/32 拍 tick，但这个 拍是【每条判定线的
    本地拍刻度】，不是全局统一拍轴
    音符的判定秒：
         realSec = (time / 32) * 60 / line.bpm
    本适配器以真实秒轴为基准重建全局 BPM 段，再把音符秒映射回全局拍轴
    （段内线性：beat = 累计拍 + (sec - 段起点秒) * bpm / 60）

   变速判别：
   秒轴 run 聚类：把全音符按秒排序后，连续同 bpm 的音符合并成 run
    长 run 即秒跨度 ≥ 2s 或音符数 ≥ 8 视为真 BPM 段信号，触发切段
    短 run 视为零星异 bpm 音（假变速 / 演出用），音符保留
    （判定秒不变）但不触发切段，拍值按其秒所在段的 bpm 映射
    段边界取新 bpm 音符首次出现的秒，无音空窗按前段 bpm 计拍
   ========================================================= */
registerChartAdapter(
  "phi-official",
  raw => !!raw && typeof raw == "object" && typeof raw.formatVersion == "number" && Array.isArray(raw.judgeLineList) && !raw.BPMList && !raw.META,
  function (raw) {
    const TICKS_PER_BEAT = 32

    // 收集全部note换算真实判定秒
    const TYPE_TAP = 0
    const TYPE_DRAG = 1
    const TYPE_HOLD_TAIL = 2
    const notes = []   // { sec, ticks, bpm, column, noteType }
    for (const line of raw.judgeLineList) {
      if (!line || typeof line.bpm !== "number" || line.bpm <= 0) continue
      for (const list of [line.notesAbove, line.notesBelow]) {
        if (!Array.isArray(list)) continue
        for (const n of list) {
          if (!n || typeof n.time !== "number") continue
          const ntype = typeof n.type == "number" ? n.type : 1
          const headSec = n.time / TICKS_PER_BEAT * 60 / line.bpm
          if (ntype === 2) {
            notes.push({ sec: headSec, ticks: n.time, bpm: line.bpm, column: n.positionX, noteType: TYPE_DRAG })
          } else {
            notes.push({ sec: headSec, ticks: n.time, bpm: line.bpm, column: n.positionX, noteType: TYPE_TAP })
          }
          if (ntype === 3 && typeof n.holdTime == "number" && n.holdTime > 0) {
            const endTicks = n.time + n.holdTime
            const endSec = endTicks / TICKS_PER_BEAT * 60 / line.bpm
            if (endSec > headSec) {
              notes.push({ sec: endSec, ticks: endTicks, bpm: line.bpm, column: n.positionX, noteType: TYPE_HOLD_TAIL })
            }
          }
        }
      }
    }
    if (!notes.length) {
      return { time: [{ beat: [0, 0, 1], bpm: 120 }], taps: [], bgmOffsetSec: 0, musicDelayedEntry: true }
    }
    notes.sort((a, b) => a.sec - b.sec)

    // 秒轴 run 聚类，连续同 bpm 的音符合并为一个 run
    const runs = []   // { bpm, startSec, endSec, count }
    for (const x of notes) {
      const last = runs[runs.length - 1]
      if (last && last.bpm == x.bpm) { last.endSec = x.sec; last.count++ }
      else runs.push({ bpm: x.bpm, startSec: x.sec, endSec: x.sec, count: 1 })
    }

    // 段构建
    //  每条长 run 生成一对事件：
    //  (startSec,       PUSH bpm)  到达该秒时切换到该长 run bpm 作为新段
    //  (endSec + 1μs,   POP  bpm)  长 run 结束后，弹栈回到之前的 bpm
    //  栈顶 = 当前生效 BPM；栈空 = 主 BPM（首条长 run 的 bpm）
    //  按秒扫描事件：相邻事件秒之间 = 一段，bpm = 当前栈顶 / 主BPM
    const MIN_SPAN_SEC = 2
    const MIN_RUN_NOTES = 8
    const longRuns = runs.filter(r => (r.endSec - r.startSec) >= MIN_SPAN_SEC || r.count >= MIN_RUN_NOTES)
    const masterBpm = longRuns.length ? longRuns[0].bpm : (notes[0]?.bpm ?? 120)
    const EV = []   // [sec, kind, bpm]   kind: 0=POP, 1=PUSH
    const EPS_POP = 1e-6
    for (const lr of longRuns) {
      EV.push([Math.max(0, lr.startSec), 1, lr.bpm])
      EV.push([lr.endSec + EPS_POP, 0, lr.bpm])
    }
    EV.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const segments = []   // { startSec, bpm }
    const stack = []
    const currentBpm = () => stack.length ? stack[stack.length - 1] : masterBpm
    let prevSec = 0
    for (const [sec, kind, bpm] of EV) {
      if (sec < prevSec - 1e-9) continue
      if (sec > prevSec + 1e-9) {
        const b = currentBpm()
        const last = segments[segments.length - 1]
        if (last && last.bpm == b) { }
        else segments.push({ startSec: prevSec, bpm: b })
      }
      if (kind == 1) stack.push(bpm)
      else {
        const idx = stack.lastIndexOf(bpm)
        if (idx >= 0) stack.splice(idx, 1)
      }
      prevSec = sec
    }
    // 尾段
    const b = currentBpm()
    const last = segments[segments.length - 1]
    if (last && last.bpm == b) {}
    else segments.push({ startSec: Math.max(0, prevSec), bpm: b })
    if (!segments.length) segments.push({ startSec: 0, bpm: masterBpm })

    // 段边界拍 + 段起点秒
    //  段内音符拍值可解析写成 beat = T/32 − Ψ（T 为该判定线 tick、
    //  Ψ = 段起点秒 × bpm/60 − 段起点拍）。T/32 已是音符在自身判定线网格上的位置，
    //  所以 Ψ 与该段音符的 tick 相位 φ = (T/32) mod 0.5 不同余时，整段音符会一起偏
    //  同一相位（phi/IN.json 的 140 回 250 段 Ψ = 26.768、φ = 0，全段恒定偏 0.232 拍 ≈ 56ms）。
    //  段边界落在「上一段末音 ~ 本段首音」的无音空窗内，该区间拍轴无观测约束、取值自由，
    //  故段边界拍取「使 Ψ ≡ φ (mod 0.5)」的最近解；φ 落在 1/2 拍网格上时再优先 Ψ ∈ ℤ，
    //  让该线整拍 tick 落在整数拍上（与首段 startBeat = 0 的相位约定一致）。不能一律取整：
    //  140 线的音符 tick 本身在 1/4 偏移上（φ = 0.25），取整会把对齐的 140 段弄错位。
    //  段起点秒取该拍在轴上的时间 → deltaSec 恒为 0 → 音符时间 = 官谱判定秒，不做平移
    //（靠 deltaSec 平移音符来凑对齐会让整段提前、与音频脱节）。
    const rawSec = segments.map(sg => sg.startSec)   // 原始边界秒（run 起止），仅用于外推

    // 各段音符的 tick 相位 φ = (T/32) mod 0.5（取众数，量化到 1/32 拍）
    const segPhase = segments.map(function (sg, k) {
      const nextStart = (k + 1 < segments.length) ? rawSec[k + 1] : Infinity
      const bins = {}
      let total = 0
      for (const x of notes) {
        if (x.bpm !== sg.bpm) continue
        if (x.sec < rawSec[k] || x.sec >= nextStart) continue
        const key = Math.round((((x.ticks / TICKS_PER_BEAT) % 0.5 + 0.5) % 0.5) * TICKS_PER_BEAT)
        bins[key] = (bins[key] || 0) + 1
        total++
      }
      if (!total) return null
      let best = 0, bestN = -1
      for (const key of Object.keys(bins)) {
        if (bins[key] > bestN) { bestN = bins[key]; best = Number(key) }
      }
      return best / TICKS_PER_BEAT
    })

    const snapBeat = v => Math.round(v * 4) / 4
    const segBeats = [0]
    const segTimes = [0]
    for (let k = 1; k < segments.length; k++) {
      const p = 60 / segments[k - 1].bpm        // 上一段：秒/拍
      const q = segments[k].bpm / 60            // 本段：拍/秒
      const c = p * q - 1                       // dΨ/dB
      const B0 = segBeats[k - 1], T0 = segTimes[k - 1]
      const psiAt = B => (T0 + (B - B0) * p) * q - B
      const rawNext = B0 + (rawSec[k] - rawSec[k - 1]) / p
      // 合法窗口：段起点秒须落在「上一段末音之后、本段首音之前」，否则所属段判定会乱
      let lo = -Infinity, hi = Infinity
      for (const x of notes) {
        if (x.sec < rawSec[k]) { if (x.sec > lo) lo = x.sec }
        else if (x.sec < hi) hi = x.sec
      }
      let B = snapBeat(rawNext)
      const phi = segPhase[k]
      if (phi !== null && Math.abs(c) > 1e-9) {
        const psiRaw = psiAt(rawNext)
        const onHalfGrid = Math.abs(phi - Math.round(phi * 2) / 2) < 1e-9
        const mods = onHalfGrid ? [1, 0.5] : [0.5]
        for (const mod of mods) {
          const cand = phi + Math.round((psiRaw - phi) / mod) * mod
          const candB = rawNext + (cand - psiRaw) / c
          const candT = T0 + (candB - B0) * p
          if (candT >= lo - 1e-9 && candT <= hi + 1e-9) { B = candB; break }
        }
      }
      segBeats.push(B)
      segTimes.push(T0 + (B - B0) * p)
    }
    // 段起点秒 = 该拍在轴上的时间
    for (let k = 1; k < segments.length; k++) segments[k].startSec = segTimes[k]
    // time[] 是最终给 chart-core 的标准段表：beat 三元组 + 该段 bpm
    // chart-core 会对 time[] 做「beat 差分 × 60/bpm 积分」得到标准 seconds，
    // 所以用完全相同的算法把 note.sec 映射到 beatVal
    const time = segments.map((sg, k) => ({
      beat: beatToTriple(segBeats[k]),
      bpm: sg.bpm
    }))
    const stdSegs = []
    let accumulated = 0
    for (let k = 0; k < time.length; k++) {
      const startBeat = segBeats[k]
      const endBeat = (k + 1 < time.length) ? segBeats[k + 1] : Infinity
      stdSegs.push({ startBeat, endBeat, bpm: time[k].bpm, startTime: accumulated })
      if (k + 1 < time.length) accumulated += (endBeat - startBeat) * 60 / time[k].bpm
    }
    // deltaSec 恒为 0：段起点秒已取为该拍在轴上的时间（见上一步）
    const deltaSec = segments.map(() => 0)
    function rawSecToStdSec(sec) {
      // 段定位，落在哪个原始 segments[k]
      let k = segments.length - 1
      for (let i = 0; i < segments.length; i++) {
        const nextStart = (i + 1 < segments.length) ? segments[i + 1].startSec : Infinity
        if (sec < nextStart) { k = i; break }
      }
      return sec + deltaSec[k]
    }
    // second → beat
    const secToBeat = stdSec => {
      if (stdSec < stdSegs[0].startTime) {
        return stdSegs[0].startBeat + (stdSec - stdSegs[0].startTime) * stdSegs[0].bpm / 60
      }
      for (const s of stdSegs) {
        const endSec = isFinite(s.endBeat) ? s.startTime + (s.endBeat - s.startBeat) * 60 / s.bpm : Infinity
        if (stdSec >= s.startTime - 1e-9 && stdSec < endSec) {
          return s.startBeat + (stdSec - s.startTime) * s.bpm / 60
        }
      }
      const last = stdSegs[stdSegs.length - 1]
      return last.startBeat + (stdSec - last.startTime) * last.bpm / 60
    }
    const taps = notes.map(x => ({ beatVal: secToBeat(rawSecToStdSec(x.sec)), column: x.column, noteType: x.noteType }))

    // offset
    const offsetSec = (typeof raw.offset == "number") ? raw.offset : 0
    return { time, taps, bgmOffsetSec: -offsetSec, musicDelayedEntry: true }
  }
)

// 浮点拍值 → 最简分数三元组 [整数拍, 分子, 分母]。
// 变速段边界拍值不再是 1/32 网格（如 112 + 3/56 拍），用连分数逼近（分母 ≤ 4096）
function beatToTriple(val) {
  if (!isFinite(val) || val < 0) return [0, 0, 1]
  let n0 = 0, n1 = 1, d0 = 1, d1 = 0   // 当前逼近分数 n1/d1（初始 1/0 = ∞）
  let x = val
  for (let i = 0; i < 64; i++) {
    const a = Math.floor(x)
    const n2 = a * n1 + n0, d2 = a * d1 + d0
    if (d2 > 4096) break
    n0 = n1; n1 = n2; d0 = d1; d1 = d2
    if (Math.abs(n1 / d1 - val) < 1e-9) break
    const f = x - a
    if (f < 1e-12) break
    x = 1 / f
  }
  if (d1 == 0) return [Math.floor(val), 0, 1]
  const A = Math.floor(n1 / d1)
  const rem = n1 - A * d1
  return rem == 0 ? [A, 0, 1] : [A, rem, d1]
}
