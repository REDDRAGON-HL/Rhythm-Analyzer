/* =========================================================
   Phigros RPE 格式支持（phi-rpe.js）
   根结构含 BPMList + META + judgeLineList

   结构映射：
    BPMList[{ bpm, startTime:[小节,分子,分母] }] → time[{ beat, bpm }]
     音频位置 = 谱面时间 + bgmOffsetSec，故取 -offset/1000
   ========================================================= */
registerChartAdapter(
  "phi-rpe",
  raw => !!raw && typeof raw == "object" && Array.isArray(raw.judgeLineList) && Array.isArray(raw.BPMList),
  function (raw) {
    const taps = []
    const TYPE_TAP = 0
    const TYPE_DRAG = 1
    const TYPE_HOLD_TAIL = 2
    for (const line of raw.judgeLineList) {
      if (!line || !Array.isArray(line.notes)) continue
      for (const n of line.notes) {
        if (!n || n.isFake) continue
        const startBeat = beatToVal(n.startTime)
        const ntype = typeof n.type == "number" ? n.type : 1
        if (ntype === 3) {
          taps.push({ beatVal: startBeat, column: n.positionX, noteType: TYPE_TAP })
          const endBeat = beatToVal(n.endTime)
          if (endBeat > startBeat) {
            taps.push({ beatVal: endBeat, column: n.positionX, noteType: TYPE_HOLD_TAIL })
          }
        } else if (ntype === 2) {
          taps.push({ beatVal: startBeat, column: n.positionX, noteType: TYPE_DRAG })
        } else {
          taps.push({ beatVal: startBeat, column: n.positionX, noteType: TYPE_TAP })
        }
      }
    }
    const offsetMs = (raw.META && typeof raw.META.offset == "number")
      ? raw.META.offset
      : (typeof raw.offset == "number" ? raw.offset : 0)
    return {
      time: raw.BPMList.map(t => ({ beat: t.startTime, bpm: t.bpm })),
      taps,
      bgmOffsetSec: -offsetMs / 1000,
      musicDelayedEntry: true
    }
  }
)
