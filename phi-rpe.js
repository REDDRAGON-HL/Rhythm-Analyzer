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
    for (const line of raw.judgeLineList) {
      if (!line || !Array.isArray(line.notes)) continue
      for (const n of line.notes) {
        if (!n || n.isFake) continue
        taps.push({ beatVal: beatToVal(n.startTime), column: n.positionX })
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
