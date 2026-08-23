/* =========================================================
   osu!mania 谱面格式支持（osu-mania.js）
   靠扩展名 kind="osu" 或文件头 "osu file format vN" 按内容识别

   时间模型：谱面 beat0 对齐第一个 uninherited TimingPoint，
     该点之前的音频前奏按 bgmOffsetSec 正偏移跳过（起播直接 seek），
     与统一约定"音频位置 = 谱面时间 + bgmOffsetSec"一致。
   inherited TimingPoint（负 beatLength / uninherited=0，滚动速度）
     不参与节奏换算，忽略。
   Hold（type bit 128）取按下时刻为节奏点，结尾释放不算新音；
     column = floor(x * 键数 / 512)，仅解析不参与渲染。
   ========================================================= */
registerChartAdapter(
  "osu-mania",
  (raw, kind) => kind === "osu" || (typeof raw === "string" && /^osu file format v\d/.test(raw)),
  function (raw) {
    // 逐行分节解析
    const sections = {}
    let cur = ""
    for (const line of String(raw).split(/\r?\n/)) {
      const t = line.trim()
      if (!t || t.startsWith("//")) continue
      const m = t.match(/^\[(.+)\]$/)
      if (m) { cur = m[1]; continue }
      (sections[cur] = sections[cur] || []).push(t)
    }
    const kv = (arr, key) => {
      if (!arr) return undefined
      for (const l of arr) {
        const i = l.indexOf(":")
        if (l.slice(0, i).trim() === key) return l.slice(i + 1).trim()
      }
    }

    const keys = parseFloat(kv(sections.Difficulty, "CircleSize")) || 4

    // uninherited TimingPoints：time,beatLength(ms/拍),meter,...,uninherited,...
    const tps = []
    for (const l of (sections.TimingPoints || [])) {
      const p = l.split(",")
      const t = parseFloat(p[0])
      const bl = parseFloat(p[1])
      if (!isFinite(t) || !isFinite(bl)) continue
      if (bl <= 0) continue // inherited（负值 = 滚动倍率）
      if (p.length >= 7 && p[6] === "0") continue // 显式标记 inherited
      // SV 用极端 beatLength 的假 uninherited 点做滚动效果（0.01~2ms 的
      //   "百万 BPM" 或 60000+ms 的假停顿）。真实音乐不会低于 6 或高于 6000 BPM，
      //   这类点直接丢弃，节拍按前后的真实 TP 换算
      if (bl < 10 || bl > 10000) continue
      // 紧邻同 BPM 的重复强调点（常出现在假点夹层后）不是真变速，合并掉
      if (tps.length && Math.abs(tps[tps.length - 1].bl - bl) < 1e-9) continue
      tps.push({ t, bl })
    }
    if (!tps.length) throw new Error("osu 谱中未找到有效的 uninherited TimingPoint")

    // 累计拍：各 TP 的起始拍（beat0 = 第一个 TP）
    let acc = 0
    const segs = []
    const time = []
    for (let i = 0; i < tps.length; i++) {
      if (i > 0) acc += (tps[i].t - tps[i - 1].t) / tps[i - 1].bl
      segs.push({ t: tps[i].t, bl: tps[i].bl, beat: acc })
      time.push({ beat: [acc, 0, 1], bpm: 60000 / tps[i].bl })
    }

    // HitObjects：x,y,time,type,hitSound[,...]。TP 与音符都按时间升序 → 双指针定段
    const taps = []
    let si = 0
    for (const l of (sections.HitObjects || [])) {
      const p = l.split(",")
      const x = parseFloat(p[0])
      const t = parseFloat(p[2])
      const type = parseInt(p[3], 10)
      if (!isFinite(t) || !isFinite(type)) continue
      if ((type & 1) === 0 && (type & 128) === 0) continue // 只取 tap / hold
      while (si < segs.length - 1 && t >= segs[si + 1].t) si++
      const s = segs[si]
      taps.push({
        beatVal: s.beat + (t - s.t) / s.bl,
        column: isFinite(x) ? Math.max(0, Math.min(keys - 1, Math.floor(x * keys / 512))) : 0
      })
    }

    return {
      time,
      taps,
      bgmOffsetSec: segs[0].t / 1000
    }
  }
)
