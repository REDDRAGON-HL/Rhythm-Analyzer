/* =========================================================
   非 Worker 导出模块
   三条导出链路：
     1. 黑底 MP4：主线程逐帧drawExportFrame → VideoFrame postMessage 给 export-worker（WebCodecs H.264 + AAC → mp4-muxer）
     2. 透明 MOV PNG（ffmpeg.wasm 单实例一次性编码）：逐帧画 PNG 写 FS → ffmpeg -c:v png -pix_fmt rgba + AAC mux → MOV
     3. PNG 序列 zip：逐帧 toBlob PNG + WAV → JSZip 打包 zip。
   前置依赖：chart-core.js / malody-mc.js / osu-mania.js
   所有 const / let / function 保持全局作用域（与内联 script 共享词法环境）
   ========================================================= */

// 导出画布的字体栈
const EXPORT_FONT = () => document.body.classList.contains("custom-font")
  ? "'UserFont', 'Microsoft YaHei', sans-serif"
  : "'Microsoft YaHei', sans-serif"

/* =========================================================
   逐帧渲染播放区→VideoFrame发给export-worker（VideoEncoder H.264 + AudioEncoder AAC + mp4-muxer）
   音频：解码后按时间轴调度进OfflineAudioContext渲染
   ========================================================= */
const EXPORT_SCALE = 2    // 2 倍分辨率
let EXPORT_FPS = 60       // 视频帧率
let EXPORT_SR = 48000     // 音频采样率
// 背景模式
let exportBg = "black"
let exportFmt = "source"  // "source" / "mp4" / "mkv" / "mov" / "avi"
let exportPanelT = false  // BPM 面板透明
// BPM 动画状态
let exportLastShownBpm = null
let exportBpmFlashStartSec = -1 // 最近一次 BPM 切换对应的导出视频秒数；-1 表示无动画中

// 填充色
const EXPORT_COLORS = {
  "std-4": "#1038ff", "std-8": "#ff182f", "std-16": "#4da6ff", "std-32": "#4de0ff",
  "dot-4": "#1038ff", "dot-8": "#ff182f", "dot-16": "#4da6ff",
  "trip-3": "#22d27e", "trip-6": "#22d27e", "trip-12": "#ffa94d", "trip-24": "#9aff6e",
  "quin-5": "#8b4dd2", "quin-10": "#c266ff", "quin-20": "#ff6dd1",
  "sept-7": "#7c6bff", "sept-14": "#b59cff",
  "nine-9": "#1fbfb0", "nine-18": "#34d399"
}
// 时值色
const EXPORT_VALUE_COLORS = {
  "std-value": "#93c5fd", "dot-value": "#fca5a5", "trip-value": "#86efac",
  "quin-value": "#e9d5ff", "sept-value": "#c7d2fe", "nine-value": "#6ee7b7"
}

let exportCanvas = null, exportCtx = null, exportW = 0, exportH = 0
let exportWorker = null
let exportCancelFlag = false
let exportPendingAcks = 0

// 取消导出
function cancelExport() {
  if (!state.exporting) return
  exportCancelFlag = true
  $("exportBtn").textContent = "正在取消…"
}

// worker 消息分发
const exportWaiters = {}
function exportAwait(type) {
  return new Promise(function (resolve, reject) {
    (exportWaiters[type] = exportWaiters[type] || []).push({ resolve, reject })
  })
}
// 出错时让所有等待中的步骤直接失败
function rejectExportWaiters(err) {
  for (const k of Object.keys(exportWaiters)) {
    const list = exportWaiters[k]
    exportWaiters[k] = []
    for (const w of list) w.reject(err)
  }
}
function attachExportWorker(onError) {
  exportWorker.onmessage = function (e) {
    const d = e.data
    if (d.type == "ack") {
      exportPendingAcks = Math.max(0, exportPendingAcks - 1)
    } else if (d.type == "warn") {
      console.warn("导出:", d.message)
    } else if (d.type == "error") {
      const err = new Error(d.message)
      onError(err)
      rejectExportWaiters(err)
    } else if (exportWaiters[d.type] && exportWaiters[d.type].length) {
      exportWaiters[d.type].shift().resolve(d)
    }
  }
  exportWorker.onerror = function (e) {
    const err = new Error(e.message || "worker 加载失败")
    onError(err)
    rejectExportWaiters(err)
  }
}
// 背压，当在途消息太多时等worker消化
function awaitExportAcks() {
  return new Promise(function (resolve) {
    const check = () => (exportPendingAcks <= 4 ? resolve() : setTimeout(check, 4))
    check()
  })
}

// 解码音频为AudioBuffer，重采样到EXPORT_SR
async function decodeExportAudio(url) {
  const resp = await fetch(url)
  const buf = await resp.arrayBuffer()
  const ctx = new OfflineAudioContext(2, 1, EXPORT_SR)
  return await ctx.decodeAudioData(buf)
}

//  合成整段音频
async function mixExportAudio(outputDur) {
  const chart = state.chart
  const speed = state.speed
  const ctx = new OfflineAudioContext(2, Math.ceil((outputDur + 0.3) * EXPORT_SR), EXPORT_SR)

  let haveAny = false
  if (songAudio) {
    try {
      const songBuf = await decodeExportAudio(songAudio.src)
      let off = chart.bgmOffsetSec || 0
      if (off < 0 && !chart.musicDelayedEntry) off = 0
      const src = ctx.createBufferSource()
      src.buffer = songBuf
      src.playbackRate.value = speed
      const gain = ctx.createGain()
      gain.gain.value = songVolume
      src.connect(gain).connect(ctx.destination)
      if (off >= 0) src.start(0, Math.min(off, songBuf.duration))
      else src.start(-off / speed, 0)
      haveAny = true
    } catch (err) { console.warn("歌曲解码失败，导出不含歌曲:", err); }
  }
  if (hitPool.length) {
    try {
      const hitBuf = await decodeExportAudio(hitPool[0].src)
      for (const nt of chart.notes) {
        const t = nt.second / speed
        if (t >= outputDur) break
        // 多押按chordCount调度多个源
        for (let k = 0; k < (nt.chordCount || 1); k++) {
          const src = ctx.createBufferSource()
          src.buffer = hitBuf
          src.connect(ctx.destination)
          src.start(t)
        }
      }
      haveAny = true
    } catch (err) { console.warn("打击音解码失败，导出不含打击音:", err); }
  }
  if (!haveAny) return null
  return await ctx.startRendering()
}

// 混好的AudioBuffer切块送worker编码f32-planar
async function sendExportAudio(mixed) {
  const n = mixed.length
  const ch0 = mixed.getChannelData(0)
  const ch1 = mixed.numberOfChannels > 1 ? mixed.getChannelData(1) : ch0
  const CHUNK = EXPORT_SR
  for (let off = 0; off < n; off += CHUNK) {
    if (exportCancelFlag) return
    const frames = Math.min(CHUNK, n - off)
    const planar = new Float32Array(frames * 2)
    planar.set(ch0.subarray(off, off + frames), 0)
    planar.set(ch1.subarray(off, off + frames), frames)
    const ad = new AudioData({
      format: "f32-planar",
      sampleRate: EXPORT_SR,
      numberOfFrames: frames,
      numberOfChannels: 2,
      data: planar,
      timestamp: Math.round(off / EXPORT_SR * 1e6)
    })
    exportPendingAcks++
    exportWorker.postMessage({ type: "audio", data: ad }, [ad])
    await awaitExportAcks()
  }
}

const EXPORT_CROP_L = 24
const EXPORT_CROP_T = 54
const EXPORT_CROP_H = 140

/* PNG 序列导出工具（逐帧带alpha的png+wav打包zip） ===== */
// CRC32
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32(u8) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function makeZip(files) { // files: [{name, data:Uint8Array}]
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = enc.encode(f.name)
    const crc = crc32(f.data)
    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, 0x04034b50, true)  // local header 签名
    lh.setUint16(4, 20, true)          // 版本
    lh.setUint16(8, 0, true)           // store
    lh.setUint32(14, crc, true)
    lh.setUint32(18, f.data.length, true)
    lh.setUint32(22, f.data.length, true)
    lh.setUint16(26, name.length, true)
    parts.push(new Uint8Array(lh.buffer), name, f.data)
    const ch = new DataView(new ArrayBuffer(46))
    ch.setUint32(0, 0x02014b50, true)  // central 目录签名
    ch.setUint16(4, 20, true)
    ch.setUint16(6, 20, true)
    ch.setUint32(16, crc, true)
    ch.setUint32(20, f.data.length, true)
    ch.setUint32(24, f.data.length, true)
    ch.setUint16(28, name.length, true)
    ch.setUint32(42, offset, true)
    central.push(new Uint8Array(ch.buffer), name)
    offset += 30 + name.length + f.data.length
  }
  const centralSize = central.reduce((a, p) => a + p.length, 0)
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, files.length, true)
  eocd.setUint16(10, files.length, true)
  eocd.setUint32(12, centralSize, true)
  eocd.setUint32(16, offset, true)
  return new Blob([...parts, ...central, new Uint8Array(eocd.buffer)], { type: "application/zip" })
}

// AudioBuffer → 16bit PCM WAV
function audioBufferToWav(buf) {
  const n = buf.length, ch = Math.min(2, buf.numberOfChannels), sr = buf.sampleRate
  const bytes = 44 + n * ch * 2
  const dv = new DataView(new ArrayBuffer(bytes))
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)) }
  ws(0, "RIFF"); dv.setUint32(4, bytes - 8, true); ws(8, "WAVE"); ws(12, "fmt ")
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true)
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * ch * 2, true)
  dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true)
  ws(36, "data"); dv.setUint32(40, n * ch * 2, true)
  const chans = []
  for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c))
  let off = 44
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]))
      dv.setInt16(off, v < 0 ? v * 32768 : v * 32767, true)
      off += 2
    }
  }
  return new Uint8Array(dv.buffer)
}

// 序列导出
async function exportPngSequence(chart, outputDur) {
  const speed = state.speed
  const totalFrames = Math.max(1, Math.ceil(outputDur * EXPORT_FPS))
  const files = []
  for (let k = 0; k < totalFrames; k++) {
    if (exportCancelFlag) return
    drawExportFrame((k / EXPORT_FPS) * speed)
    const blob = await new Promise(r => exportCanvas.toBlob(r, "image/png"))
    files.push({ name: "frame_" + String(k).padStart(5, "0") + ".png", data: new Uint8Array(await blob.arrayBuffer()) })
    if (k % 10 == 0) {
      $("exportBtn").textContent = "导出中… " + Math.round(k / totalFrames * 100) + "%"
      await new Promise(r => setTimeout(r, 0))
    }
  }
  if (exportCancelFlag) return
  const mixed = await mixExportAudio(outputDur)
  if (mixed) files.push({ name: "audio.wav", data: audioBufferToWav(mixed) })
  files.push({
    name: "info.txt",
    data: new TextEncoder().encode(
      "帧率: " + EXPORT_FPS + " fps\n音频采样率: " + EXPORT_SR + " Hz\n" +
      "帧数: " + totalFrames + "\n\n将 frame_*.png 按序列导入剪辑软件（按文件名顺序），并设置序列帧率为 " + EXPORT_FPS + "。\n含透明通道，叠加在其他素材上即可。\naudio.wav 为音轨。\n"
    )
  })
  const zip = makeZip(files)
  const a = document.createElement("a")
  a.href = URL.createObjectURL(zip)
  a.download = exportFileName("zip")
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000)
}

/* =========================================================
   透明mov导出（png无损alpha + aac，ffmpeg.wasm单实例编码）

   单ffmpeg实例逐帧渲染writeFile全部帧，追加 audio.wav
    一次 exec：-f image2 序列→png codec (-pred mixed, pix_fmt rgba) + aac mux→直接出out.mov
    -vf fps:round=near:start_time=0 + settb=AVTB + setpts=N/(FPS*TB) 写死每帧PTS，消除concat累积误差
    总帧数/视频时长基准优先用mixed.duration
    不要用playEndSeconds/speed！！！！！！！会有累计误差越来越偏！！！！！！！！！！！！！！！1

   ========================================================= */
async function exportWebmTransparent(chart, outputDur, mixed) {
  const speed = state.speed
  const durSec = mixed ? mixed.duration : outputDur
  const totalFrames = Math.max(1, Math.ceil(durSec * EXPORT_FPS))

  const { FFmpeg } = await import("./lib/ffmpeg/index.js")

  const blobURL = async (u, type) => {
    const resp = await fetch(u)
    const b = await resp.blob()
    return URL.createObjectURL(new Blob([b], { type }))
  }

  $("exportBtn").textContent = "导出中… 加载 ffmpeg-core"
  await new Promise(r => setTimeout(r, 0))

  // 核心资源url
  const coreURL = await blobURL(new URL("./lib/ffmpeg/core/ffmpeg-core.esm.js", location.href).href, "text/javascript")
  const wasmURL = await blobURL(new URL("./lib/ffmpeg/core/ffmpeg-core.wasm", location.href).href, "application/wasm")
  const workerURL = new URL("./lib/ffmpeg/worker.js", location.href).href

  // 创建并加载全新ffmpeg实例
  const createFFmpeg = async () => {
    const inst = new FFmpeg()
    inst._lastLogs = []  // runExec 用：缓存最近 40 行，失败时附在错误信息里
    const loggerCb = ({ type, message }) => {
      const line = "[ffmpeg:" + (type || "?") + "] " + (message ?? "")
      try { inst._lastLogs.push(line) } catch (_) { /* ignore */ }
      if (inst._lastLogs && inst._lastLogs.length > 40) {
        inst._lastLogs.splice(0, inst._lastLogs.length - 40)
      }
      if (type == "error" || type == "warn") {
        console.log(line)
      } else if (message && (
        message.indexOf("Error") !== -1 ||
        message.indexOf("error") !== -1 ||
        message.indexOf("Invalid") !== -1 ||
        message.indexOf("Failed") !== -1 ||
        message.indexOf("Unable") !== -1 ||
        message.indexOf("Unknown") !== -1 ||
        message.indexOf("Output file is empty") !== -1
      )) {
        console.log(line)
      }
    }
    inst.on("log", loggerCb)
    await inst.load({ coreURL, wasmURL, workerURL })
    return inst
  }

  // 统一ffmpeg.exec包装
  const runExec = async (inst, args, stageLabel) => {
    const argsStr = args.join(" ")
    console.log("[ffmpeg " + stageLabel + "] ffmpeg " + argsStr)
    const res = await inst.exec(args)
    let exitCode
    if (typeof res == "number") exitCode = res
    else if (res && typeof res.exitCode == "number") exitCode = res.exitCode
    else exitCode = 0
    if (exitCode !== 0) {
      const lastLogs = (inst && inst._lastLogs) ? inst._lastLogs.join("\n") : ""
      const msg = (stageLabel || "ffmpeg") + " 失败（exit=" + exitCode + "）：\nffmpeg " + argsStr + "\n---- 最近日志 ----\n" + (lastLogs || "(无日志)")
      console.error(msg)
      throw new Error(msg)
    }
    return exitCode
  }

  const deleteFile = async (inst, path) => {
    try {
      if (typeof inst.deleteFile == 'function') await inst.deleteFile(path)
    } catch (_) { }
  }

  const toErr = (e) => {
    if (e instanceof Error) return e
    const msg = (e && e.message) || (typeof e == 'string' ? e : String(e)) || '未知错误'
    return new Error(msg)
  }

  try {
    // 单实例逐帧渲染
    let inst = null
    let finalU8 = null
    try {
      inst = await createFFmpeg()

      // 每帧画完立即释放主线程该帧
      for (let idx = 0; idx < totalFrames; idx++) {
        if (exportCancelFlag) return
        drawExportFrame((idx / EXPORT_FPS) * speed)
        const blob = await new Promise(r => exportCanvas.toBlob(r, "image/png"))
        const u8 = new Uint8Array(await blob.arrayBuffer())
        const fname = "frame_" + String(idx).padStart(5, "0") + ".png"
        await inst.writeFile(fname, u8)

        if (idx % 5 == 0) {
          const prog = Math.min(75, Math.round((idx + 1) / totalFrames * 75))
          $("exportBtn").textContent = prog + "% 渲染帧 " + (idx + 1) + "/" + totalFrames
          await new Promise(r => setTimeout(r, 0))
        }
      }

      if (exportCancelFlag) return

      $("exportBtn").textContent = "导出中… 80% 写入音频"
      await new Promise(r => setTimeout(r, 0))

      const hasAudio = !!mixed
      if (hasAudio) {
        const wavU8 = audioBufferToWav(mixed)
        await inst.writeFile("audio.wav", wavU8)
      }

      if (exportCancelFlag) return

      // 一次 exec
      $("exportBtn").textContent = "导出中… 90% 编码 MOV"
      await new Promise(r => setTimeout(r, 0))

      const onePassArgs = []
      onePassArgs.push("-f", "image2")
      onePassArgs.push("-start_number", "0")
      onePassArgs.push("-r", String(EXPORT_FPS))
      onePassArgs.push("-i", "frame_%05d.png")
      if (hasAudio) {
        onePassArgs.push("-i", "audio.wav")
      }
      onePassArgs.push("-fflags", "+genpts")
      onePassArgs.push("-avoid_negative_ts", "make_zero")
      if (hasAudio) {
        onePassArgs.push("-map", "0:v:0")
        onePassArgs.push("-map", "1:a:0")
      } else {
        onePassArgs.push("-map", "0:v:0")
      }
      // 视频filter，fps对齐
      onePassArgs.push("-vf", "fps=fps=" + EXPORT_FPS + ":round=near:start_time=0,settb=AVTB,setpts=N/(" + EXPORT_FPS + "*TB)")
      onePassArgs.push("-frames:v", String(totalFrames))
      onePassArgs.push("-c:v", "png")
      onePassArgs.push("-pred", "mixed")
      onePassArgs.push("-pix_fmt", "rgba")
      if (hasAudio) {
        // 音频filter，按采样号写死pts抵消acc pre-roll
        onePassArgs.push("-af", "asetpts=N/SR/TB")
        onePassArgs.push("-c:a", "aac")
        onePassArgs.push("-b:a", "192k")
        onePassArgs.push("-ar", "48000")
        onePassArgs.push("-ac", "2")
      }
      onePassArgs.push("-t", String(durSec))
      onePassArgs.push("-f", "mov")
      onePassArgs.push("out.mov")

      await runExec(inst, onePassArgs, "MOV 一次编码")
      if (exportCancelFlag) return

      // 清理帧文件
      for (let idx = 0; idx < totalFrames; idx++) {
        const fname = "frame_" + String(idx).padStart(5, "0") + ".png"
        await deleteFile(inst, fname)
      }
      if (hasAudio) await deleteFile(inst, "audio.wav")

      $("exportBtn").textContent = "导出中… 96% 读取产物"
      await new Promise(r => setTimeout(r, 0))
      const r = await inst.readFile("out.mov")
      if (!(r && r.byteLength > 0)) throw new Error("编码产物为空（MOV PNG 一次编码失败）")
      finalU8 = new Uint8Array(r)
    } catch (rawE) {
      throw toErr(rawE)
    } finally {
      if (inst) { try { inst.terminate() } catch (_) { } }
    }

    if (exportCancelFlag) return

    // 按需格式转换
    $("exportBtn").textContent = "导出中… 98% 输出文件"
    await new Promise(r => setTimeout(r, 0))
    if (!finalU8 || finalU8.length == 0) throw new Error("最终产物为空")
    let blob = new Blob([finalU8], { type: "video/quicktime" })
    finalU8 = null
    // 转码（保持源格式时此函数立即原样返回）
    blob = await postProcessConvert(blob, exportFmt, true)
    if (exportCancelFlag) return
    const outExt =
      exportFmt == "mp4" ? "mp4" :
        exportFmt == "mov" ? "mov" :
          exportFmt == "mkv" ? "mkv" :
            exportFmt == "avi" ? "avi" :
              exportFmt == "webm8" || exportFmt == "webm9" ? "webm" :
                "mov"
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = exportFileName(outExt)
    document.body.appendChild(a)
    a.click()
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000)
  } finally {
    try { URL.revokeObjectURL(coreURL) } catch (_) { }
    try { URL.revokeObjectURL(wasmURL) } catch (_) { }
  }
}

// 格式转换
async function postProcessConvert(srcBlob, targetFmt, srcHasAlpha) {
  if (targetFmt == "source"
    || !srcBlob || !srcBlob.type
    || !srcBlob.type.startsWith("video/")) {
    return srcBlob
  }

  const { FFmpeg } = await import("./lib/ffmpeg/index.js")
  const ffmpeg = new FFmpeg()
  ffmpeg._lastLogs = []
  const blobURL = async (u, type) => {
    const resp = await fetch(u)
    const b = await resp.blob()
    return URL.createObjectURL(new Blob([b], { type }))
  }
  const runExecLocal = async (args, stageLabel) => {
    const argsStr = args.join(" ")
    console.log("[convert " + stageLabel + "] ffmpeg " + argsStr)
    const res = await ffmpeg.exec(args)
    let exitCode
    if (typeof res == "number") exitCode = res
    else if (res && typeof res.exitCode == "number") exitCode = res.exitCode
    else exitCode = 0
    if (exitCode !== 0) {
      const lastLogs = (ffmpeg._lastLogs || []).join("\n")
      const msg = (stageLabel || "转码") + " 失败（exit=" + exitCode + "）：\nffmpeg " + argsStr + "\n最近日志\n" + (lastLogs || "(无日志)")
      console.error(msg)
      throw new Error(msg)
    }
    return exitCode
  }

  $("exportBtn").textContent = "导出中… 加载转码引擎"
  await new Promise(r => setTimeout(r, 0))

  const coreURL = await blobURL(new URL("./lib/ffmpeg/core/ffmpeg-core.esm.js", location.href).href, "text/javascript")
  const wasmURL = await blobURL(new URL("./lib/ffmpeg/core/ffmpeg-core.wasm", location.href).href, "application/wasm")
  const workerURL = new URL("./lib/ffmpeg/worker.js", location.href).href

  try {
    const loggerCb = ({ type, message }) => {
      const line = "[convert:" + (type || "?") + "] " + (message ?? "")
      try { ffmpeg._lastLogs.push(line) } catch (_) { /* ignore */ }
      if (ffmpeg._lastLogs && ffmpeg._lastLogs.length > 40) {
        ffmpeg._lastLogs.splice(0, ffmpeg._lastLogs.length - 40)
      }
      if (type == "error" || type == "warn") console.log(line)
      else if (message && (
        message.indexOf("Error") !== -1 || message.indexOf("error") !== -1 ||
        message.indexOf("Invalid") !== -1 || message.indexOf("Failed") !== -1 ||
        message.indexOf("Unable") !== -1 || message.indexOf("Unknown") !== -1 ||
        message.indexOf("Output file is empty") !== -1
      )) console.log(line)
    }
    ffmpeg.on("log", loggerCb)
    await ffmpeg.load({ coreURL, wasmURL, workerURL })

    if (exportCancelFlag) return srcBlob

    // 按源MIME写入正确扩展名
    const srcExt =
      (srcBlob.type == "video/mp4") ? "mp4" :
        (srcBlob.type == "video/quicktime") ? "mov" :
          "webm"
    const srcName = "src." + srcExt
    const srcU8 = new Uint8Array(await srcBlob.arrayBuffer())
    await ffmpeg.writeFile(srcName, srcU8)
    if (exportCancelFlag) return srcBlob

    //   mov→PNG codec in QuickTime (pix_fmt rgba)
    //   avi→PNG codec in AVI (pix_fmt bgra)
    //   mp4/mkv→不支持alpha
    const keepAlpha = srcHasAlpha &&
      (targetFmt == "mov" || targetFmt == "avi")
    let outName, args
    if (targetFmt == "webm8" || targetFmt == "webm9") {
      // 有病吧webm还留在这
      return srcBlob
    }
    switch (targetFmt) {
      case "mp4":
        outName = "out.mp4"
        args = [
          "-i", srcName,
          "-c:v", "libx264", "-pix_fmt", "yuv420p",
          "-preset", "fast", "-crf", "23",
          "-c:a", "aac", "-b:a", "192k",
          "-movflags", "+faststart",
          "-avoid_negative_ts", "make_zero",
          "-shortest",
          outName
        ]
        break
      case "mkv":
        outName = "out.mkv"
        args = [
          "-i", srcName,
          "-c:v", "libx264", "-pix_fmt", "yuv420p",
          "-preset", "fast", "-crf", "23",
          "-c:a", "aac", "-b:a", "192k",
          "-avoid_negative_ts", "make_zero",
          "-shortest",
          outName
        ]
        break
      case "mov":
        outName = "out.mov"
        if (keepAlpha) {
          args = [
            "-i", srcName,
            "-c:v", "png", "-pix_fmt", "rgba",
            "-pred", "mixed",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            "-avoid_negative_ts", "make_zero",
            "-shortest",
            outName
          ]
        } else {
          args = [
            "-i", srcName,
            "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-preset", "fast", "-crf", "23",
            "-c:a", "aac", "-b:a", "192k",
            "-movflags", "+faststart",
            "-avoid_negative_ts", "make_zero",
            "-shortest",
            outName
          ]
        }
        break
      case "avi":
        outName = "out.avi"
        if (keepAlpha) {
          args = [
            "-i", srcName,
            "-c:v", "png", "-pix_fmt", "bgra",
            "-pred", "mixed",
            "-c:a", "libmp3lame", "-b:a", "192k",
            "-avoid_negative_ts", "make_zero",
            "-shortest",
            outName
          ]
        } else {
          args = [
            "-i", srcName,
            "-c:v", "mpeg4", "-qscale:v", "3",
            "-c:a", "libmp3lame", "-b:a", "192k",
            "-avoid_negative_ts", "make_zero",
            "-shortest",
            outName
          ]
        }
        break
      default:
        return srcBlob
    }

    $("exportBtn").textContent = "导出中… 格式转换中"
    await new Promise(r => setTimeout(r, 0))
    await runExecLocal(args, "→" + targetFmt)
    if (exportCancelFlag) return srcBlob

    const r = await ffmpeg.readFile(outName)
    if (!(r && r.byteLength > 0)) {
      const lastLogs = (ffmpeg._lastLogs || []).join("\n")
      throw new Error("转码产物为空\n---- 最近日志 ----\n" + (lastLogs || "(无日志)"))
    }
    const mime =
      targetFmt == "mp4" ? "video/mp4" :
        targetFmt == "mov" ? "video/mp4" :
          targetFmt == "mkv" ? "video/x-matroska" :
            targetFmt == "avi" ? "video/x-msvideo" :
              "video/webm"
    return new Blob([new Uint8Array(r)], { type: mime })
  } catch (e) {
    const msg = (e && e.message) || (typeof e == 'string' ? e : String(e)) || '未知错误'
    console.error("格式转换失败：", e)
    alert("格式转换失败：" + msg + "\n已回退下载原格式文件")
    return srcBlob
  } finally {
    try { ffmpeg.terminate() } catch (_) { }
    try { URL.revokeObjectURL(coreURL) } catch (_) { }
    try { URL.revokeObjectURL(wasmURL) } catch (_) { }
  }
}

function setupExportCanvas() {
  const box = document.querySelector(".chart-area")
  // 编码器要求宽高为偶数
  exportW = Math.floor((box.clientWidth - EXPORT_CROP_L) / 2) * 2
  exportH = Math.floor(EXPORT_CROP_H / 2) * 2
  if (!exportCanvas) {
    exportCanvas = document.createElement("canvas")
    exportCanvas.style.display = "none"
    document.body.appendChild(exportCanvas)
  }
  exportCanvas.width = exportW * EXPORT_SCALE
  exportCanvas.height = exportH * EXPORT_SCALE
  exportCtx = exportCanvas.getContext("2d")
}

function exportFileName(ext) {
  const src = ($("fileLabel").textContent || "").trim() || "chart"
  const clean = src.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40)
  return clean + "-export." + (ext || "mp4")
}

// 把播放区当前帧画进导出画布
function drawExportFrame(sec) {
  const chart = state.chart
  if (!chart || !exportCtx) return
  const ctx = exportCtx
  const ppb = state.pixelsPerBeat
  const beat = secondToBeat(sec, chart.bpmSegments)
  const y0 = 54        // 时间轴顶部 = chart padding24 + wrap padding30
  const midY = y0 + 70 // 中线 / 音符中心
  const judgeX = 194   // 判定环圆心 = playHead left166 + 28
  const W = exportW, H = exportH
  const xOf = b => judgeX + (b - beat) * ppb

  ctx.setTransform(EXPORT_SCALE, 0, 0, EXPORT_SCALE, -EXPORT_CROP_L * EXPORT_SCALE, -EXPORT_CROP_T * EXPORT_SCALE)
  if (exportBg !== "black") {
    ctx.clearRect(EXPORT_CROP_L, EXPORT_CROP_T, W, H)
  } else {
    ctx.fillStyle = "#000"
    ctx.fillRect(EXPORT_CROP_L, EXPORT_CROP_T, W, H)
  }

  // 中线
  ctx.fillStyle = "rgba(255,255,255,0.15)"
  ctx.fillRect(0, midY - 1, W, 2)

  // 可见拍范围
  const bMin = beat - (judgeX + 20) / ppb
  const bMax = beat + (W + 20) / ppb

  // 拍号
  const beatUnit = chart.beatUnit || 4
  const beatStep = 4 / beatUnit
  const subStep = beatStep / (state.subdivision || 4)
  const barBeats = chart.barBeats || 4

  // 线
  ctx.fillStyle = "rgba(255,255,255,0.06)"
  {
    const startN = Math.ceil(bMin / subStep)
    const endN = Math.floor(bMax / subStep)
    for (let n = startN; n <= endN; n++) {
      const b = n * subStep
      const isBeat = Math.abs(b / beatStep - Math.round(b / beatStep)) < 1e-6
      if (isBeat) continue
      ctx.fillRect(Math.round(xOf(b)), y0 + 40, 1, 60)
    }
  }
  ctx.fillStyle = "rgba(255,255,255,0.2)"
  {
    const startN = Math.ceil(bMin / beatStep)
    const endN = Math.floor(bMax / beatStep)
    for (let n = startN; n <= endN; n++) {
      const b = n * beatStep
      const isBar = Math.abs(b / barBeats - Math.round(b / barBeats)) < 1e-6
      if (isBar) continue
    ctx.fillRect(Math.round(xOf(b)), y0 + 32, 1, 76)
  }
  }
  ctx.font = "700 13px " + EXPORT_FONT()
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  const firstBar = Math.ceil(bMin / barBeats)
  const lastBar = Math.floor(bMax / barBeats)
  for (let bar = firstBar; bar <= lastBar; bar++) {
    const x = Math.round(xOf(bar * barBeats))
    ctx.fillStyle = bar % 2 == 0 ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.3)"
    ctx.fillRect(x, y0 + 32, 1, 76)
    ctx.fillStyle = "rgba(255,255,255,0.75)"
    ctx.fillText(String(bar), x, y0 + 14)
  }
  chart.bpmSegments.forEach(function (s, i) {
    if (i == 0) return
    const x = Math.round(xOf(s.startBeat))
    if (x < -5 || x > W + 5) return
    ctx.strokeStyle = "rgba(77,224,255,0.9)"
    ctx.setLineDash([4, 4])
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(x, y0 + 32); ctx.lineTo(x, y0 + 108); ctx.stroke()
    ctx.setLineDash([])
    const tag = String(Math.round(s.bpm))
    ctx.font = "800 11px " + EXPORT_FONT()
    const tw = ctx.measureText(tag).width + 12
    ctx.fillStyle = "rgba(0,0,0,0.6)"
    ctx.fillRect(x - tw / 2, y0 + 122, tw, 17)
    ctx.fillStyle = "#4de0ff"
    ctx.fillText(tag, x, y0 + 131)
  })

  // note
  for (let i = 0; i < chart.notes.length; i++) {
    const nt = chart.notes[i]
    if (nt.beatVal <= beat) continue
    const x = xOf(nt.beatVal)
    if (x > W + 20) break
    if (x < 150) continue
    const y = midY
    const dotted = nt.actualValueInfo.dotted
    const isChordHi = state.showChords && nt.chordCount >= 2
    ctx.lineWidth = isChordHi ? 2.5 : 2
    ctx.strokeStyle = isChordHi ? "#fbbf24" : "rgba(255,255,255,0.9)"
    if (isChordHi) { ctx.shadowColor = "rgba(251,191,36,0.65)"; ctx.shadowBlur = 16 }
    ctx.fillStyle = EXPORT_COLORS[nt.colorInfo.cls] || "#4da6ff"
    if (dotted) {
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(Math.PI / 4)
      ctx.fillRect(-15, -15, 30, 30)
      ctx.strokeRect(-15, -15, 30, 30)
      ctx.restore()
    } else {
      ctx.beginPath()
      ctx.arc(x, y, 15, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
    if (isChordHi) { ctx.shadowBlur = 0; ctx.shadowColor = "transparent" }
    let displayNum = null
    if (dotted) displayNum = "·"
    else if (nt.colorInfo.num && !nt.colorInfo.dotted) displayNum = nt.colorInfo.num
    if (displayNum) {
      ctx.fillStyle = "#fff"
      ctx.font = (dotted ? "900 16px " : "800 12px ") + EXPORT_FONT()
      ctx.fillText(displayNum, x, y + 1)
    }
    if (4 / nt.actualValueInfo.v <= 4) {
      const vc = (4 / nt.actualValueInfo.v > 1) ? "std-value" : nt.actualValueInfo.valueClass
      ctx.fillStyle = EXPORT_VALUE_COLORS[vc] || "#93c5fd"
      ctx.font = "700 11px " + EXPORT_FONT()
      ctx.fillText(nt.beatLabel || nt.actualValueInfo.label, x, y0 + 107)
    }
  }

  // BPM 面板和切换动画
  const curBpm = bpmAt(beat)
  const roundedBpm = Math.round(curBpm)
  if (roundedBpm !== exportLastShownBpm) {
    exportLastShownBpm = roundedBpm
    if (state.bpmAnim) exportBpmFlashStartSec = sec
  }
  // rawP ∈ [0,1]：0 = 峰值当帧，1 = 动画结束
  let rawP = -1
  if (exportBpmFlashStartSec >= 0) {
    rawP = Math.max(0, Math.min(1, (sec - exportBpmFlashStartSec) / 1.0))
    if (rawP >= 1) exportBpmFlashStartSec = -1
  }
  // ease(cubic-bezier(0.25, 0.1, 0.25, 1))，easeOutBack
  const u = rawP < 0 ? 1 : rawP  // u: 0→1（时间推移）
  const pEase = rawP < 0 ? 1 : easeFlash(u)
  // bpmScale: 当帧峰值1.09→随ease回落至1.0（pEase 越大越接近结束，scale 越接近 1
  const bpmScale = rawP < 0 ? 1 : (1 + 0.09 * (1 - pEase))
  // bpmGlow: 光晕强度1→0，随ease衰减
  const bpmGlow = rawP < 0 ? 0 : Math.max(0, 1 - pEase)

  if (exportPanelT && exportBg !== "black") {
    ctx.clearRect(24, y0, 130, 140)
  } else {
    ctx.fillStyle = "#0f172a"
    ctx.fillRect(24, y0, 130, 140)
    if (bpmGlow > 0.001) {
      const glowAlpha = Math.min(0.12, 0.12 * bpmGlow)
      ctx.fillStyle = "rgba(255,255,255," + glowAlpha.toFixed(5) + ")"
      ctx.fillRect(24, y0, 130, 140)
    }
  }
  ctx.strokeStyle = "rgba(255,255,255,0.15)"
  ctx.lineWidth = 1
  ctx.strokeRect(24.5, y0 + 0.5, 129, 139)
  const glowBlurPx = rawP < 0 ? 0 : (21 * bpmGlow)
  ctx.fillStyle = "#fff"
  if (glowBlurPx > 0.05) {
    ctx.shadowColor = "rgba(255,255,255,1)"
    ctx.shadowBlur = glowBlurPx
  }
  ctx.font = "600 14px " + EXPORT_FONT()
  ctx.fillText("BPM", 89, y0 + 48)
  if (glowBlurPx > 0.05) { ctx.shadowBlur = 0; ctx.shadowColor = "transparent" }
  const bigFontSize = 36 * bpmScale
  ctx.font = "800 " + bigFontSize + "px " + EXPORT_FONT()
  if (glowBlurPx > 0.05) {
    ctx.shadowColor = "rgba(255,255,255,1)"
    ctx.shadowBlur = glowBlurPx
  }
  ctx.fillText(String(roundedBpm), 89, y0 + 88)
  if (glowBlurPx > 0.05) { ctx.shadowBlur = 0; ctx.shadowColor = "transparent" }

  // 判定环
  ctx.strokeStyle = "#fff"
  ctx.lineWidth = 2.5
  ctx.beginPath()
  ctx.arc(judgeX, midY, 19, 0, Math.PI * 2)
  ctx.stroke()
}

function restoreAfterExport() {
  for (const k of Object.keys(exportWaiters)) delete exportWaiters[k]
  exportPendingAcks = 0
  state.exporting = false
  exportCancelFlag = false
  $("exportBtn").textContent = "导出"
  $("playBtn").disabled = !state.chart
  $("pauseBtn").disabled = true
  $("resetBtn").disabled = !state.chart
  $("speedSel").disabled = false
}

async function startExport(cfg) {
  if (!state.chart || state.exporting) return
  const c = cfg || {}
  exportBg = c.bg || "black"
  exportFmt = c.fmt || "source"
  exportPanelT = !!c.panelTransparent && exportBg !== "black"
  EXPORT_FPS = c.fps || 60
  EXPORT_SR = (exportBg == "transparent" || exportBg == "pngseq") ? 48000 : (c.sr || 48000)
  const isWebm = exportBg == "transparent"

  if (exportBg == "black" && (!window.VideoEncoder || !window.AudioEncoder)) {
    alert("当前浏览器不支持 MP4 导出（缺少 WebCodecs）\n可尝试透明 MOV PNG 或 PNG 序列导出，或换用 Chrome/Edge 94+")
    return
  }
  // 自定义字体就绪后再逐帧渲染
  try { await document.fonts.ready } catch (e) { }
  state.exporting = true
  exportCancelFlag = false
  exportLastShownBpm = null
  exportBpmFlashStartSec = -1
  $("playBtn").disabled = true
  $("pauseBtn").disabled = true
  $("resetBtn").disabled = true
  $("speedSel").disabled = true
  $("exportBtn").textContent = "导出中… 0%"

  const chart = state.chart
  const speed = state.speed
  const outputDur = chart.playEndSeconds / speed
  const totalFrames = Math.max(1, Math.ceil(outputDur * EXPORT_FPS))

  try {
    // 透明mov，ffmpeg.wasm单实例一次性编码
    if (exportBg == "transparent") {
      setupExportCanvas()
      const mixed = await mixExportAudio(outputDur)
      if (exportCancelFlag) return
      await exportWebmTransparent(chart, outputDur, mixed)
      return // finally恢复界面
    }

    // png序列，逐帧toBlob+wav打包zip
    if (exportBg == "pngseq") {
      setupExportCanvas()
      await exportPngSequence(chart, outputDur)
      return
    }

    // 1) 画布 + worker + 编码器初始化
    setupExportCanvas()
    exportWorker = new Worker("export-worker.js")
    let fatal = null
    attachExportWorker((err) => { fatal = fatal || err; })
    const failFast = () => { if (fatal) throw fatal; }

    const readyP = exportAwait("ready")
    exportWorker.postMessage({
      type: "init",
      container: isWebm ? "webm" : "mp4",
      videoCodecs: ["avc1.640028", "avc1.4d0028", "avc1.42001f"], // High → Main → Baseline 兜底
      width: exportCanvas.width,
      height: exportCanvas.height,
      fps: EXPORT_FPS,
      audio: { sampleRate: EXPORT_SR, channels: 2 }
    })
    await readyP
    failFast()

    const mixed = await mixExportAudio(outputDur)

    // 逐帧渲染，第k帧画谱面时间(k/60)*speed的状态
    const KEY_INT = 120 // 每 2 秒一个关键帧
    for (let k = 0; k < totalFrames; k++) {
      if (exportCancelFlag || fatal) break
      drawExportFrame((k / EXPORT_FPS) * speed)
      const frame = new VideoFrame(exportCanvas, {
        timestamp: Math.round(k * 1e6 / EXPORT_FPS),
        duration: Math.round(1e6 / EXPORT_FPS)
      })
      exportPendingAcks++
      exportWorker.postMessage(
        { type: "frame", frame, keyFrame: k % KEY_INT == 0 },
        [frame]
      )
      await awaitExportAcks()
      // 定期让出主线程更新进度
      if (k % 30 == 0) {
        $("exportBtn").textContent = "导出中… " + Math.round(k / totalFrames * 100) + "%（点击取消）"
        await new Promise((r) => setTimeout(r, 0))
      }
    }
    failFast()

    if (exportCancelFlag) {
      exportWorker.terminate()
      exportWorker = null
      return
    }

    // 收尾，音频分块编码，封装成 mp4
    const vdP = exportAwait("video-done")
    exportWorker.postMessage({ type: "flush-video" })
    await vdP
    failFast()

    if (mixed) await sendExportAudio(mixed)
    failFast()

    const resultP = exportAwait("result")
    exportWorker.postMessage({ type: "finish" })
    const result = await resultP
    failFast()
    exportWorker.terminate()
    exportWorker = null

    // 下载
    let blob = new Blob([result.buffer], { type: isWebm ? "video/webm" : "video/mp4" })
    blob = await postProcessConvert(blob, exportFmt, /* srcHasAlpha */ exportBg !== "black")
    if (exportCancelFlag) return
    const outExt =
      exportFmt == "mp4" ? "mp4" :
        exportFmt == "mov" ? "mov" :
          exportFmt == "mkv" ? "mkv" :
            exportFmt == "avi" ? "avi" :
              (exportFmt == "webm8" || exportFmt == "webm9") ? "webm" :
                (isWebm ? "webm" : "mp4")
    const a = document.createElement("a")
    a.href = URL.createObjectURL(blob)
    a.download = exportFileName(outExt)
    document.body.appendChild(a)
    a.click()
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000)
  } catch (err) {
    if (exportWorker) { try { exportWorker.terminate(); } catch (e2) { /* ignore */ } exportWorker = null; }
    const msg = (err && err.message) || (typeof err == 'string' ? err : String(err)) || '未知错误'
    alert("导出失败: " + msg)
    console.error("导出失败：", err)
  } finally {
    restoreAfterExport()
  }
}
