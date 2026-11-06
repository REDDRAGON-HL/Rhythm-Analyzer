/* =========================================================
   节奏解析工具自身的谱面 JSON（rhythm-json.js）
   ---------------------------------------------------------
   依赖 chart-core.js 先加载（registerChartAdapter / valToBeat 全局可用）。

   用途：把「编辑 note」之后的谱面存成文件，之后可以再导入。
   与其它格式不同，这里不做任何格式转换——直接把解析管线里的单个音
   （含 hold 尾拍、drag、用户增删改后的拍值）原样写出：

     {
       "format": "rhythm-analyzer",
       "version": 1,
       "source": "原文件名",
       "time":   [{ "beatVal": 0, "bpm": 180 }, …],          // 拍值用小数（四分音符为单位）
       "taps":   [{ "beatVal": 12.25, "noteType": 0, "column": 0 }, …],
       "meters": [{ "beat": 0, "num": 4, "den": 4 }, …],     // 可选：初始 + 节点拍号
       "bgmOffsetSec": 0.263,
       "musicDelayedEntry": false
     }

   拍值用小数而不是 [A,B,C]：7 连 / 9 连这类分母无法用 96 精确表示，
     小数能保证往返后位置一致。适配器内部再用 valToBeat 换成拍数组。
   ========================================================= */
registerChartAdapter(
  "rhythm-json",
  raw => !!raw && typeof raw == "object" && raw.format === "rhythm-analyzer" && Array.isArray(raw.taps),
  function (raw) {
    // 小数拍值 → [A, B, 1e6]（chart-core 的 buildBpmSegments 只吃拍数组）
    // 1e6 分母下误差 ≤ 5e-7，小于同拍去重的 DEDUP_EPS(1e-6)
    const beatArrOf = function (v) {
      const D = 1000000
      const n = Math.round(v * D)
      return [Math.floor(n / D), n - Math.floor(n / D) * D, D]
    }
    const taps = (raw.taps || []).map(function (t) {
      return {
        beatVal: (typeof t.beatVal == "number") ? t.beatVal : beatToVal(t.beat || [0, 0, 1]),
        column: t.column,
        noteType: t.noteType || 0
      }
    })
    const time = (raw.time || []).map(function (t) {
      const v = (typeof t.beatVal == "number") ? t.beatVal : beatToVal(t.beat || [0, 0, 1])
      return { beat: beatArrOf(v), bpm: t.bpm }
    })
    return {
      time,
      taps,
      meters: Array.isArray(raw.meters) ? raw.meters : undefined,
      bgmOffsetSec: (typeof raw.bgmOffsetSec == "number") ? raw.bgmOffsetSec : 0,
      musicDelayedEntry: !!raw.musicDelayedEntry
    }
  }
)
