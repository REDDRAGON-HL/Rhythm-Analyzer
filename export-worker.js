/* =========================================================
   导出编码 Worker（export-worker.js）
   ---------------------------------------------------------
   主线程逐帧渲染画布 → new VideoFrame(canvas) postMessage 过来，
   这里用 VideoEncoder（H.264）编码；音频以 AudioData(f32-planar)
   分块送入 AudioEncoder（AAC）；mp4-muxer 封装成 mp4 整体回传。
   依赖同目录 lib/mp4-muxer.min.js（importScripts）。

   消息严格串行处理：handler 是 async 的，若并发进入下一条消息，
     背压encodeQueueSize会让多帧的唤醒顺序错乱
   ========================================================= */
importScripts("lib/mp4-muxer.min.js")

let muxer = null
let videoEncoder = null
let audioEncoder = null

const msgQueue = []
let processing = false

self.onmessage = function (e) {
  msgQueue.push(e.data)
  if (!processing) processQueue()
}

async function processQueue() {
  processing = true
  while (msgQueue.length) {
    const msg = msgQueue.shift()
    try {
      await handleMessage(msg)
    } catch (err) {
      postMessage({ type: "error", message: (err && err.message) || String(err) })
    }
  }
  processing = false
}

async function handleMessage(msg) {
  if (msg.type === "init") {
    // 视频编码配置
    // profile 兜底：High → Main → Baseline，取第一个支持的
    let vConfig = null
    for (const codec of (msg.videoCodecs || [])) {
      const cfg = {
        codec,
        width: msg.width,
        height: msg.height,
        bitrate: 8000000,
        framerate: msg.fps,
        latencyMode: "realtime"
      }
      const sup = await VideoEncoder.isConfigSupported(cfg)
      if (sup.supported) { vConfig = cfg; break; }
    }
    if (!vConfig) throw new Error("视频编码器不支持 H.264（avc）")

    // 音频编码配置
    let audioOk = false
    if (msg.audio) {
      const aConfig = {
        codec: "mp4a.40.2",
        sampleRate: msg.audio.sampleRate,
        numberOfChannels: msg.audio.channels,
        bitrate: 192000
      }
      const aSupport = await AudioEncoder.isConfigSupported(aConfig)
      audioOk = aSupport.supported
      if (!audioOk) postMessage({ type: "warn", message: "AAC 编码不可用，导出的视频不含音频" })
      else {
        audioEncoder = new AudioEncoder({
          output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
          error: (err) => postMessage({ type: "error", message: "音频编码错误: " + err.message })
        })
        audioEncoder.configure(aConfig)
      }
    }

    muxer = new Mp4Muxer.Muxer({
      target: new Mp4Muxer.ArrayBufferTarget(),
      video: { codec: "avc", width: msg.width, height: msg.height },
      audio: audioOk && audioEncoder
        ? { codec: "aac", numberOfChannels: msg.audio.channels, sampleRate: msg.audio.sampleRate }
        : undefined,
      // in-memory，先攒再写moov
      fastStart: "in-memory"
    })

    videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (err) => postMessage({ type: "error", message: "视频编码错误: " + err.message })
    })
    videoEncoder.configure(vConfig)
    postMessage({ type: "ready", audio: audioOk })
    return
  }

  if (msg.type === "frame") {
    // 背压
    while (videoEncoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 4))
    }
    videoEncoder.encode(msg.frame, { keyFrame: !!msg.keyFrame })
    msg.frame.close()
    postMessage({ type: "ack" })
    return
  }

  if (msg.type === "flush-video") {
    await videoEncoder.flush()
    postMessage({ type: "video-done" })
    return
  }

  if (msg.type === "audio") {
    if (audioEncoder) audioEncoder.encode(msg.data)
    msg.data.close()
    postMessage({ type: "ack" })
    return
  }

  if (msg.type === "finish") {
    if (audioEncoder) await audioEncoder.flush()
    muxer.finalize()
    // 整个 mp4 buffer 转移回主线程
    postMessage({ type: "result", buffer: muxer.target.buffer }, [muxer.target.buffer])
    return
  }
}
