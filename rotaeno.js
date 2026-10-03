function isRotaenoChart(raw) {
  if (typeof raw !== "string") return false
  const text = raw.replace(/^\uFEFF/, "").trim()
  return /^#\s+Version\s+\d+\s*(?:\r?\n|$)/i.test(text)
    && /^#\s+BPM\s*$/im.test(text) && /^#\s+Note\s*$/im.test(text)
}

function extractRotaenoChart(raw) {
  if (!isRotaenoChart(raw)) throw new Error("不是 Rotaeno 谱面：需要 # Version 数字 文件头及 # BPM、# Note 分段")
  const events = []
  const notes = []
  let section = ""
  const lines = raw.replace(/^\uFEFF/, "").split(/\r?\n/)
  function number(parts, index, lineNumber) {
    const value = Number(parts[index])
    if (!parts[index] || !Number.isFinite(value)) throw new Error(`Rotaeno 第 ${lineNumber} 行：第 ${index + 1} 个字段不是有效数字`)
    return value
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    if (line.startsWith("#")) {
      const header = line.toLowerCase().replace(/\s+/g, " ")
      if (header === "# bpm") section = "bpm"
      else if (header === "# note") section = "note"
      else if (header === "# speed") section = "speed"
      else section = "" // 如 # Tag：元数据段，不能继续当作 BPM / note 读取
      continue
    }

    const parts = line.split("#")[0].split(",").map(p => p.trim())
    if (section === "bpm") {
      const timeMs = number(parts, 0, i + 1)
      const bpm = number(parts, 1, i + 1)
      if (bpm <= 0) throw new Error(`Rotaeno 第 ${i + 1} 行：BPM 必须大于 0`)
      events.push({ timeMs, bpm })
    } else if (section === "note") {
      const kind = Math.trunc(number(parts, 0, i + 1))
      if (![0, 1, 2, 4, 5].includes(kind)) continue
      const timeMs = number(parts, 1, i + 1)
      const column = number(parts, 2, i + 1)
      const note = { kind, timeMs, column }
      if (kind === 2) {
        if (parts.length < 9) throw new Error(`Rotaeno 第 ${i + 1} 行：slide 需要 9 个字段`)
        for (let field = 3; field < 9; field++) number(parts, field, i + 1)
        note.slideType = Math.trunc(Number(parts[3]))
      } else if (kind === 4) {
        if (parts.length < 6) throw new Error(`Rotaeno 第 ${i + 1} 行：rotate 需要 6 个字段`)
        for (let field = 3; field < 6; field++) number(parts, field, i + 1)
      }
      notes.push(note)
    }
  }
  if (!events.length) events.push({ timeMs: 0, bpm: 120 })
  events.sort((a, b) => a.timeMs - b.timeMs)
  // 同毫秒 BPM 取最后一个，避免零长度分段
  const segments = []
  for (const event of events) {
    const last = segments[segments.length - 1]
    if (last && last.timeMs === event.timeMs) last.bpm = event.bpm
    else segments.push({ ...event })
  }
  let beat = 0
  for (let i = 0; i < segments.length; i++) {
    if (i) beat += (segments[i].timeMs - segments[i - 1].timeMs) * segments[i - 1].bpm / 60000
    segments[i].beat = beat
  }
  function segmentAt(timeMs) {
    let lo = 0, hi = segments.length - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (segments[mid].timeMs <= timeMs) lo = mid
      else hi = mid - 1
    }
    return segments[lo]
  }
  function timeToBeat(timeMs) {
    const s = segmentAt(timeMs)
    return s.beat + (timeMs - s.timeMs) * s.bpm / 60000
  }
  const taps = []
  for (const note of notes) {
    if (note.kind === 2 && ![0, 1, 3].includes(note.slideType)) continue
    taps.push({ beatVal: timeToBeat(note.timeMs), column: note.column, noteType: 0 })
  }
  return {
    time: segments.map(s => ({ beat: [s.beat, 0, 1], bpm: s.bpm })),
    taps,
    bgmOffsetSec: segments[0].timeMs / 1000,
    musicDelayedEntry: true
  }
}

registerChartAdapter("rotaeno", isRotaenoChart, extractRotaenoChart)

function rotaenoMeterJsonChoices(raw) {
  let data = raw
  if (typeof raw === "string") {
    try { data = JSON.parse(raw.replace(/^\uFEFF/, "")) }
    catch (err) { throw new Error("拍号 JSON 格式错误：" + err.message) }
  }
  if (Array.isArray(data)) return [{ songId: "", events: data }]
  if (!data || typeof data !== "object" || !data.songs || Array.isArray(data.songs) || typeof data.songs !== "object") {
    throw new Error("拍号 JSON 应为 [{time, numerator, denominator}, …] 数组，或包含 songs 的对象")
  }
  const choices = Object.entries(data.songs).map(([songId, events]) => {
    if (!Array.isArray(events)) throw new Error(`歌曲 ${songId} 的拍号数据必须为数组`)
    return { songId, events }
  })
  if (!choices.length) throw new Error("拍号 JSON 的 songs 中没有歌曲")
  return choices
}

function parseRotaenoMeterEvents(events, chart) {
  if (!chart || chart.format !== "rotaeno") throw new Error("拍号 JSON 仅支持 Rotaeno 谱面")
  if (!Array.isArray(events)) throw new Error("拍号数据必须为数组")
  const byBeat = new Map()
  function snapBeat(beat) {
    for (const denominator of [1, 2, 3, 4, 6, 8, 12, 16]) {
      const snapped = Math.round(beat * denominator) / denominator
      if (Math.abs(beat - snapped) <= .01 + 1e-9) return snapped
    }
    return beat
  }
  events.map((event, i) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error(`拍号 JSON 第 ${i + 1} 条必须为对象`)
    const { time, numerator } = event
    const denominator = event.denominator === undefined ? 4 : event.denominator
    if (!Number.isFinite(time) || time < 0) throw new Error(`拍号 JSON 第 ${i + 1} 条：time 必须为非负的毫秒数`)
    if (!Number.isInteger(numerator) || numerator < 1 || numerator > 32
      || !Number.isInteger(denominator) || denominator < 1 || denominator > 32) {
      throw new Error(`拍号 JSON 第 ${i + 1} 条：numerator、denominator 必须为 1 到 32 的整数`)
    }
    return { time, numerator, denominator, index: i }
  }).sort((a, b) => a.time - b.time || a.index - b.index).forEach(event => {
    // 在 beat0 之前生效的拍号沿用为初始拍号
    const startBeat = Math.max(0, snapBeat(secondToBeat(event.time / 1000 - (chart.bgmOffsetSec || 0), chart.bpmSegments)))
    byBeat.set(startBeat, { startBeat, beatsPerBar: event.numerator, beatUnit: event.denominator })
  })
  const initial = byBeat.get(0) || { beatsPerBar: 4, beatUnit: 4 }
  return {
    beatsPerBar: initial.beatsPerBar,
    beatUnit: initial.beatUnit,
    meterChanges: Array.from(byBeat.values()).filter(change => change.startBeat > 0).sort((a, b) => a.startBeat - b.startBeat),
    importedCount: byBeat.size
  }
}
