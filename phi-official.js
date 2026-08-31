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
    const TYPE_DRAG = 2
    const notes = []   // { sec, ticks, bpm, column, noteType }
    for (const line of raw.judgeLineList) {
      if (!line || typeof line.bpm !== "number" || line.bpm <= 0) continue
      for (const list of [line.notesAbove, line.notesBelow]) {
        if (!Array.isArray(list)) continue
        for (const n of list) {
          if (!n || typeof n.time !== "number") continue
          notes.push({
            sec: n.time / TICKS_PER_BEAT * 60 / line.bpm,
            ticks: n.time,
            bpm: line.bpm,
            column: n.positionX,
            noteType: (typeof n.type == "number" && n.type == TYPE_DRAG) ? TYPE_DRAG : 0
          })
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

    // 段边界拍网格吸附（好乱不知道怎么写）
    //  对第 k 段，计算「上一段 BPM 下从段 k-1 起点秒到段 k 起点秒的拍值跨度 deltaBeat」
    //  加到段 k-1 的吸附起点拍上，再 snap 到 1/SNAP_DEN 网格
    //  吸附后拍轴对应的秒（用于 note.second↔beatVal 换算）统一用「标准 time[] 连续拍积分」反推
    //  即 chart-core 会在解析时用的算法，以保证和输出给它的 time[] 完全自洽。
    const SNAP_DEN = 4
    const snapBeat = v => Math.round(v * SNAP_DEN) / SNAP_DEN
    const segBeats = [0]
    for (let k = 1; k < segments.length; k++) {
      const bpmPrev = segments[k - 1].bpm
      const secPrev0 = segments[k - 1].startSec
      const secCur0 = segments[k].startSec
      const deltaBeat = (secCur0 - secPrev0) * bpmPrev / 60
      const rawNext = segBeats[k - 1] + deltaBeat
      segBeats.push(snapBeat(rawNext))
    }
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
    // deltaSec[k]，第k段内所有 note.sec 统一加上的平移校正秒
    const deltaSec = segments.map((sg, k) => stdSegs[k].startTime - sg.startSec)
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
