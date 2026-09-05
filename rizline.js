/* =========================================================
   Rizline 谱面格式支持（rizline.js）
      ========================================================= */
registerChartAdapter(
  "rizline",
  raw => !!raw && typeof raw == "object" && typeof raw.bPM == "number"
    && Array.isArray(raw.bpmShifts) && Array.isArray(raw.lines)
    && raw.lines.length > 0 && Array.isArray(raw.lines[0].notes),
  function (raw) {
    const baseBpm = raw.bPM
    const bpmShifts = raw.bpmShifts

    // bpmShifts 按 time(tick) 排序，value为倍率
    const DENOM = 96
    function valToBeat(val) {
      const total = Math.round(val * DENOM)
      return [Math.floor(total / DENOM), total % DENOM, DENOM]
    }
    const sortedShifts = [...bpmShifts].sort((a, b) => a.time - b.time)
    const bpmSegments = []
    for (const s of sortedShifts) {
      const bpm = baseBpm * s.value
      bpmSegments.push({ beat: valToBeat(s.time), bpm, _beatVal: s.time })
    }

    const deduped = []
    for (const seg of bpmSegments) {
      if (deduped.length > 0 && deduped[deduped.length - 1]._beatVal === seg._beatVal) {
        deduped[deduped.length - 1].bpm = seg.bpm
        deduped[deduped.length - 1].beat = seg.beat
      } else {
        deduped.push(seg)
      }
    }
    for (const seg of deduped) delete seg._beatVal

    const taps = []
    for (const line of raw.lines) {
      if (!line || !Array.isArray(line.notes)) continue
      for (const n of line.notes) {
        if (!n) continue
        const beatVal = n.time
        if (n.type === 0) {
          taps.push({ beatVal, noteType: 0 })
        } else if (n.type === 1) {
          taps.push({ beatVal, noteType: 1 })
        } else if (n.type === 2) {
          // otherInformations[0] = endTime(tick)
          const endBeat = n.otherInformations && n.otherInformations.length > 0
            ? n.otherInformations[0]
            : beatVal
          taps.push({ beatVal, noteType: 0 })
          if (Math.abs(endBeat - beatVal) > 1e-6) {
            taps.push({ beatVal: endBeat, noteType: 2 })
          }
        }
      }
    }

    const chartDelayMs = typeof raw.chartDelayMs == "number" ? raw.chartDelayMs : 0
    const bgmOffsetSec = chartDelayMs / 1000

    return {
      time: deduped,
      taps,
      bgmOffsetSec,
      musicDelayedEntry: bgmOffsetSec < 0
    }
  }
)
