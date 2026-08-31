/* =========================================================
   谱面解析核心（chart-core.js），格式无关的解析管线 + 格式注册接口
   ---------------------------------------------------------
   新格式支持：格式文件调用全局 registerChartAdapter(name, detect, extract) 注册，
   在 index.html 加一行 <script> 引入即可，注册后全部解析能力自动复用。
     detect(raw, kind)
       kind = 载入文件的扩展名（小写；由 index.html 传入，缺省时只能靠内容判断）
       返回 true 表示该数据属于此格式（按注册顺序匹配，先注册先匹配）
     extract(raw) 返回统一中间结构：
       time     BPM 变化表 [{ beat:[拍, 分子, 分母], bpm }]
       taps     点击音符 [{ beatVal, column }]（顺序不限，内部会排序）
       bgmOffsetSec  音乐偏移（秒），统一约定：音频位置 = 谱面时间 + bgmOffsetSec
                     · 正值 = beat0 时音乐已进行到文件内该位置（起播直接 seek 过去）
                     · 负值 = 音乐要等谱面时间走到 |bgmOffsetSec| 才入场
       musicDelayedEntry  可选，默认 false。true 时负偏移采用"等到入场点才起播"
                          （.mc 语义），false 时起播钳到 0（转换 json 的既有行为）

   parseChart(raw, { kind }) 返回谱面对象：
     {
       meta, bpmSegments,
       notes: [{ beatVal, second, colorInfo(组色), actualValueInfo(实际时值), beatLabel, column, chordCount }],
       totalBeats, chartEndBeat, playEndBeat, totalSeconds, playEndSeconds,
       bgmOffsetSec, musicDelayedEntry, bpmFirst, rawTapCount
     }
     多押去重：排序后多押自动合并成一路，chordCount记录该点叠了几个音，rawTapCount是合并前的原始note总数；
   ========================================================= */

/* ==================== 基础计算 ==================== */
// 将 beat:[A,B,C] 转成小数拍数
function beatToVal(beatArr) {
  return beatArr[0] + beatArr[1] / beatArr[2]
}

// BPM段：累计时间计算
function buildBpmSegments(timeList) {
  // 返回 [{startBeat, endBeat, bpm, startTime}]
  const segs = []
  let accumulated = 0
  for (let i = 0; i < timeList.length; i++) {
    const startBeat = beatToVal(timeList[i].beat)
    const endBeat = (i + 1 < timeList.length) ? beatToVal(timeList[i + 1].beat) : Infinity
    segs.push({
      startBeat,
      endBeat,
      bpm: timeList[i].bpm,
      startTime: accumulated
    })
    if (i + 1 < timeList.length) {
      accumulated += (endBeat - startBeat) * 60 / timeList[i].bpm
    }
  }
  return segs
}

function beatToSecond(beatVal, segs) {
  for (const s of segs) {
    if (beatVal >= s.startBeat && beatVal < s.endBeat) {
      return s.startTime + (beatVal - s.startBeat) * 60 / s.bpm
    }
  }
  // 超过最后一段，用最后一个BPM
  const last = segs[segs.length - 1]
  return last.startTime + (beatVal - last.startBeat) * 60 / last.bpm
}

// 秒→拍（反函数）
function secondToBeat(sec, segs) {
  // 负时间用第一段 BPM 向前外推
  if (sec < segs[0].startTime) {
    const first = segs[0]
    return first.startBeat + (sec - first.startTime) * first.bpm / 60
  }
  for (const s of segs) {
    // 该段结束秒数
    const endSec = (isFinite(s.endBeat))
      ? s.startTime + (s.endBeat - s.startBeat) * 60 / s.bpm
      : Infinity
    if (sec >= s.startTime && sec < endSec) {
      return s.startBeat + (sec - s.startTime) * s.bpm / 60
    }
  }
  const last = segs[segs.length - 1]
  return last.startBeat + (sec - last.startTime) * last.bpm / 60
}

function gcd(a, b) {
  a = Math.abs(a)
  b = Math.abs(b)
  while (b !== 0) {
    const t = a % b
    a = b
    b = t
  }
  return a || 1
}

// 将拍间隔转成近似分数（如 0.21875 -> 7/32）
function formatBeatGapFraction(deltaBeat) {
  if (!isFinite(deltaBeat) || deltaBeat <= 0) return "-"
  // 先吸附音乐性分数（标准分母 + 小容差）：osu 等格式时间戳为整数毫秒，
  // 1/6 拍 ≈ 58.8ms 会被取整成 59ms，拍值带 ±0.003 拍级抖动，
  // 直接找"误差最小分数"会得到 47/286 这类无音乐意义的表示
  const MUSIC_DENS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16, 20, 24, 32, 48, 64]
  for (const den of MUSIC_DENS) {
    const num = Math.round(deltaBeat * den)
    if (num <= 0) continue
    if (Math.abs(deltaBeat - num / den) <= 0.003) {
      const k = gcd(num, den)
      return `${Math.round(num / k)}/${Math.round(den / k)}`
    }
  }
  // 无人匹配再退回全局最优分数
  let bestNum = 1
  let bestDen = 1
  let bestErr = Infinity
  const maxDen = 384
  for (let den = 1; den <= maxDen; den++) {
    const num = Math.round(deltaBeat * den)
    if (num <= 0) continue
    const err = Math.abs(deltaBeat - num / den)
    if (err < bestErr) {
      bestErr = err
      bestNum = num
      bestDen = den
    }
  }
  const k = gcd(bestNum, bestDen)
  bestNum = Math.round(bestNum / k)
  bestDen = Math.round(bestDen / k)
  // 最优分数的分母仍不在常用节拍网格内=间隔本就不在任何网格上
  const FINE_DENS = [40, 56, 80, 96, 112, 160, 192]
  if (MUSIC_DENS.indexOf(bestDen) < 0 && FINE_DENS.indexOf(bestDen) < 0) {
    return `≈${Math.round(deltaBeat * 100) / 100}`
  }
  return `${bestNum}/${bestDen}`
}

// 只有当实际间隔与标准值的理论间隔足够接近时，才视为标准标签可显示
function isCanonicalStandardGap(deltaBeat, matchedValueInfo) {
  if (!matchedValueInfo || matchedValueInfo.unknown || !isFinite(deltaBeat) || deltaBeat <= 0) {
    return false
  }
  const canonicalGap = 4 / matchedValueInfo.v
  const diff = Math.abs(deltaBeat - canonicalGap)
  // 容差 3e-3 拍；精确分数格式的谱不受影响
  return diff <= 3e-3
}


/* ==================== 时值表与匹配 ==================== */

// 合法时值表（拍数，即 4/间隔）
// v: 时值数值（附点为非整数）, label: 标签文本, cls: 颜色 CSS 类, valueClass: 标签颜色类, num: 圈内数字, group: 所属组, dotted: 是否附点
const LEGAL_VALUES = [
  // 标准组
  { v: 4, label: "4", cls: "std-4", valueClass: "std-value", num: null, group: "std" },
  { v: 8, label: "8", cls: "std-8", valueClass: "std-value", num: null, group: "std" },
  { v: 16, label: "16", cls: "std-16", valueClass: "std-value", num: null, group: "std" },
  { v: 32, label: "32", cls: "std-32", valueClass: "std-value", num: null, group: "std" },
  { v: 64, label: "32", cls: "std-32", valueClass: "std-value", num: null, group: "std" },
  { v: 2, label: "2", cls: "std-4", valueClass: "std-value", num: null, group: "std" },
  { v: 1, label: "1", cls: "std-4", valueClass: "std-value", num: null, group: "std" },
  // 附点组（v = 原时值 / 1.5，间隔 = 1.5 × 原间隔）
  { v: 2.667, label: "4.", cls: "dot-4", valueClass: "dot-value", num: "·", group: "dot", dotted: true },
  { v: 5.333, label: "8.", cls: "dot-8", valueClass: "dot-value", num: "·", group: "dot", dotted: true },
  { v: 10.667, label: "16.", cls: "dot-16", valueClass: "dot-value", num: "·", group: "dot", dotted: true },
  // 三连音（v = 4/gap，gap 越小 v 越大）
  { v: 1.333, label: "3", cls: "trip-3", valueClass: "trip-value", num: "3", group: "trip" },
  { v: 6, label: "6", cls: "trip-6", valueClass: "trip-value", num: "3", group: "trip" },
  { v: 12, label: "12", cls: "trip-12", valueClass: "trip-value", num: "3", group: "trip" },
  { v: 24, label: "24", cls: "trip-24", valueClass: "trip-value", num: "3", group: "trip" },
  { v: 48, label: "24", cls: "trip-24", valueClass: "trip-value", num: "3", group: "trip" },
  // 五连音
  { v: 5, label: "5", cls: "quin-5", valueClass: "quin-value", num: "5", group: "quin" },
  { v: 10, label: "10", cls: "quin-10", valueClass: "quin-value", num: "5", group: "quin" },
  { v: 20, label: "20", cls: "quin-20", valueClass: "quin-value", num: "5", group: "quin" },
  { v: 40, label: "20", cls: "quin-20", valueClass: "quin-value", num: "5", group: "quin" },
  // 七连音
  { v: 7, label: "7", cls: "sept-7", valueClass: "sept-value", num: "7", group: "sept" },
  { v: 14, label: "14", cls: "sept-14", valueClass: "sept-value", num: "7", group: "sept" },
  { v: 28, label: "14", cls: "sept-14", valueClass: "sept-value", num: "7", group: "sept" },
  // 九连音
  { v: 9, label: "9", cls: "nine-9", valueClass: "nine-value", num: "9", group: "nine" },
  { v: 18, label: "18", cls: "nine-18", valueClass: "nine-value", num: "9", group: "nine" },
  { v: 36, label: "18", cls: "nine-18", valueClass: "nine-value", num: "9", group: "nine" },
]

function matchValue(computedValue) {
  // 找最接近的合法值（附点的非整数 v 也参与比较）
  let best = LEGAL_VALUES[0]
  let minDiff = Math.abs(computedValue - best.v)
  for (const lv of LEGAL_VALUES) {
    const diff = Math.abs(computedValue - lv.v)
    if (diff < minDiff) { minDiff = diff; best = lv; }
  }
  // 容差：如果相对误差超过 8%，用?标记（收紧容差，避免附点被误判为普通音符）
  if (minDiff / best.v > 0.08) {
    return { ...best, unknown: true, v: Math.round(computedValue * 10) / 10, label: `≈${Math.round(computedValue * 10) / 10}` }
  }
  return { ...best }
}

/* ==================== 就近染色 ==================== */


function groupByNearestNeighbor(withBeat) {
  const n = withBeat.length
  if (n == 0) return []

  // 计算左右间隔
  const rightGap = new Array(n).fill(null)
  for (let i = 0; i < n - 1; i++) {
    const d = withBeat[i + 1].beatVal - withBeat[i].beatVal
    rightGap[i] = d > 0 ? d : null
  }
  const leftGap = new Array(n).fill(null)
  for (let i = 1; i < n; i++) {
    const d = withBeat[i].beatVal - withBeat[i - 1].beatVal
    leftGap[i] = d > 0 ? d : null
  }

  // 只有当前一个距离小于后一个距离时，才继承前一个音的颜色
  const result = []
  for (let i = 0; i < n; i++) {
    let nearestGap
    const lg = leftGap[i], rg = rightGap[i]
    if (lg != null && rg != null) {
      nearestGap = lg < rg ? lg : rg
    } else if (lg != null) {
      nearestGap = lg
    } else if (rg != null) {
      nearestGap = rg
    } else {
      nearestGap = 1.0
    }

    const color = matchValue(4 / nearestGap)
    result[i] = {
      groupColor: color,
      actualLeftGap: leftGap[i],
      actualRightGap: rightGap[i],
      index: i
    }
  }
  return result
}

/* ==================== 格式适配器注册表（主程序预留接口） ==================== */

const chartAdapters = []

// 新格式文件调用此函数注册，接口契约见文件头注释
function registerChartAdapter(name, detect, extract) {
  chartAdapters.push({ name, detect, extract })
}

/* ==================== 解析主流程 ==================== */

// opts.kind: 载入文件的扩展名（小写）；缺省时按内容匹配
function parseChart(raw, opts) {
  // 选格式适配器，抽取成统一中间结构
  const kind = opts && opts.kind
  const adapter = chartAdapters.find(a => a.detect(raw, kind))
  if (!adapter) throw new Error("无法识别的谱面格式（没有适配器匹配该数据）")
  const { time, taps, bgmOffsetSec, musicDelayedEntry } = adapter.extract(raw)

  const segs = buildBpmSegments(time)

  // drag过滤
  //   约定tap.noteType == 2 表示 drag 音
  const SHOW_DRAG_DEFAULT = true
  const showDrag = !(opts && opts.showDrag == false)
  const TYPE_DRAG = 2
  const filteredTaps = showDrag ? taps : taps.filter(t => t.noteType !== TYPE_DRAG)

  // 转换拍数并排序，保留 noteType 供 notes 字段透传（用于将来渲染/统计）
  const sorted = filteredTaps.map(t => ({ beatVal: t.beatVal, column: t.column, noteType: t.noteType || 0 }))
    .sort((a, b) => a.beatVal - b.beatVal)
  const rawTapCount = sorted.length

  //  多押去重，chordCount 记录叠加数
  const DEDUP_EPS = 1e-6
  const withBeat = []
  for (const t of sorted) {
    const prev = withBeat[withBeat.length - 1]
    if (prev && Math.abs(t.beatVal - prev.beatVal) <= DEDUP_EPS) {
      prev.chordCount++
      if (t.noteType == TYPE_DRAG) prev.hasDrag = true
    } else {
      withBeat.push({ beatVal: t.beatVal, column: t.column, chordCount: 1, noteType: t.noteType, hasDrag: (t.noteType == TYPE_DRAG) })
    }
  }

  //   就近染色分组
  const colorGroups = groupByNearestNeighbor(withBeat)

  const notes = []
  for (let i = 0; i < withBeat.length; i++) {
    const cur = withBeat[i]

    // 实际时值
    let actualValueInfo
    if (i == withBeat.length - 1) {
      // 最后一个音统一归为4分
      actualValueInfo = { ...LEGAL_VALUES.find(l => l.v == 4) }
    } else {
      const delta = withBeat[i + 1].beatVal - cur.beatVal
      if (delta <= 0) {
        const prev = (i > 0) ? notes[i - 1].actualValueInfo : LEGAL_VALUES[0]
        actualValueInfo = { ...prev }
      } else {
        actualValueInfo = matchValue(4 / delta)
      }
    }

    // 组色
    const colorInfo = colorGroups[i].groupColor

    const second = beatToSecond(cur.beatVal, segs)

    // 标签，标准音保留常规时值；非标准节奏显示与下一个音之间的实际间隔分数
    let beatLabel
    if (i == withBeat.length - 1) {
      beatLabel = actualValueInfo.label
    } else {
      const delta = withBeat[i + 1].beatVal - cur.beatVal
      beatLabel = isCanonicalStandardGap(delta, actualValueInfo)
        ? actualValueInfo.label
        : formatBeatGapFraction(delta)
    }

    notes.push({
      beatVal: cur.beatVal,
      second,
      colorInfo,
      actualValueInfo,
      beatLabel,
      column: cur.column,
      chordCount: cur.chordCount,  // 多押数量
      noteType: cur.noteType,      // 0 普通 / 2 drag
      hasDrag: cur.hasDrag         // 同拍内是否含 drag
    })
  }

  const totalBeats = withBeat.length ? withBeat[withBeat.length - 1].beatVal : 0
  //   谱面结尾 = 最后一个音所在小节+4小节
  //   播放必须滚到这条小节线完全越过判定环之后才停，而不是停在最后一个音附近
  const endBar = withBeat.length ? Math.ceil(totalBeats / 4) : 0
  const chartEndBeat = (endBar + 4) * 4
  // 总时长按谱面结尾小节算
  const totalSeconds = withBeat.length ? beatToSecond(chartEndBeat, segs) : 0
  // 再加1拍余量：结尾小节线滚过判定环圆心后停下
  const playEndBeat = chartEndBeat + 1
  const playEndSeconds = withBeat.length ? beatToSecond(playEndBeat, segs) : 0

  return {
    meta: raw.meta || {},
    bpmSegments: segs,
    notes,
    totalBeats,
    chartEndBeat,
    playEndBeat,
    totalSeconds,
    playEndSeconds,
    bgmOffsetSec,
    musicDelayedEntry: !!musicDelayedEntry,
    bpmFirst: time && time[0] ? time[0].bpm : 0,
    rawTapCount
  }
}
