/* =========================================================
   Malody 4K 谱面格式支持（malody-mc.js）
   靠扩展名 kind="mc" 识别
   偏移取 BGM 音符节点的 offset
   正值：音频位置 = 谱面时间 - offset。
   本工具统一约定为 音频位置 = 谱面时间 + bgmOffsetSec，故这里取负；
   负偏移的 .mc 需要"等到入场点再起播"（musicDelayedEntry 标记），
   不能沿用 json 的钳 0 行为（会整首错位 offset 秒）
   */
registerChartAdapter(
  "malody-mc",
  (raw, kind) => kind === "mc",
  function (raw) {
    const all = raw.note || []
    const tapNotes = all.filter(n => !("type" in n) && !("sound" in n))
    const bgmNode = all.find(n => "sound" in n || "type" in n)
    return {
      time: raw.time || [],
      taps: tapNotes.map(n => ({ beatVal: beatToVal(n.beat), column: n.column })),
      bgmOffsetSec: -((bgmNode && typeof bgmNode.offset === "number") ? bgmNode.offset / 1000 : 0),
      musicDelayedEntry: true
    }
  }
)

//   音频位置 = 谱面时间 + BGM 节点 offset（毫秒转秒，负值起播时钳到 0）
registerChartAdapter(
  "malody-json-legacy",
  raw => !!raw && typeof raw === "object" && Array.isArray(raw.note),
  function (raw) {
    const all = raw.note || []
    // 只取点击音符（排除 type/sound 的 BGM 节点）
    const tapNotes = all.filter(n => !("type" in n) && !("sound" in n))
    // BGM 节点的 offset（ms）：谱面 beat0 对应曲子音频内的时间，载入曲子时用于对齐
    const bgmNode = all.find(n => "sound" in n || "type" in n)
    return {
      time: raw.time || [],
      taps: tapNotes.map(n => ({ beatVal: beatToVal(n.beat), column: n.column })),
      bgmOffsetSec: (bgmNode && typeof bgmNode.offset === "number") ? bgmNode.offset / 1000 : 0
    }
  }
)
