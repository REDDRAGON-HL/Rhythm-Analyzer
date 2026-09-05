/* =========================================================
   导出编码 Worker（export-worker.js）
   ---------------------------------------------------------
   主线程逐帧渲染画布 → new VideoFrame(canvas) postMessage 过来，
   这里用 VideoEncoder 编码；音频以 AudioData(f32-planar) 分块送入
   AudioEncoder；封装库把成品整体回传。

   消息严格串行处理：handler 是 async 的，若并发进入下一条消息，
     背压encodeQueueSize会让多帧的唤醒顺序错乱
   ========================================================= */
importScripts("lib/mp4-muxer.min.js")
importScripts("lib/webm-muxer.min.js")

let muxer = null
let videoEncoder = null
let audioEncoder = null
let container = "mp4"

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
  if (msg.type == "init") {
    container = msg.container || "mp4"

    // 视频编码配置
    let vConfig = null
    if (container == "webm") {
      vConfig = {
        codec: "vp09.00.10.08",
        width: msg.width,
        height: msg.height,
        bitrate: 8000000,
        framerate: msg.fps,
        alpha: "keep",
        latencyMode: "realtime"
      }
      const sup = await VideoEncoder.isConfigSupported(vConfig)
      if (!sup.supported) throw new Error("当前浏览器不支持 VP9 透明编码（webm）")
    } else {
      // profile 兜底：High → Main → Baseline，取第一个支持的
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
        if (sup.supported) { vConfig = cfg; break }
      }
      if (!vConfig) throw new Error("视频编码器不支持 H.264（avc）")
    }

    // 音频编码配置
    let audioOk = false
    if (msg.audio) {
      const aConfig = container == "webm"
        ? { codec: "opus", sampleRate: 48000, numberOfChannels: msg.audio.channels, bitrate: 192000 }
        : { codec: "mp4a.40.2", sampleRate: msg.audio.sampleRate, numberOfChannels: msg.audio.channels, bitrate: 192000 }
      const aSupport = await AudioEncoder.isConfigSupported(aConfig)
      audioOk = aSupport.supported
      if (!audioOk) postMessage({ type: "warn", message: "音频编码不可用，导出的视频不含音频" })
      else {
        audioEncoder = new AudioEncoder({
          output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
          error: (err) => postMessage({ type: "error", message: "音频编码错误: " + err.message })
        })
        audioEncoder.configure(aConfig)
      }
    }

    muxer = container == "webm"
      ? new WebMMuxer.Muxer({
        target: new WebMMuxer.ArrayBufferTarget(),
        video: { codec: "V_VP9", width: msg.width, height: msg.height },
        audio: audioOk && audioEncoder
          ? { codec: "A_OPUS", numberOfChannels: msg.audio.channels, sampleRate: 48000 }
          : undefined,
        firstTimestampBehavior: "offset"
      })
      : new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: "avc", width: msg.width, height: msg.height },
        audio: audioOk && audioEncoder
          ? { codec: "aac", numberOfChannels: msg.audio.channels, sampleRate: msg.audio.sampleRate }
          : undefined,
    // in-memory，先攒再写moov
        fastStart: "in-memory",
        firstTimestampBehavior: "offset"
      })

    videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (err) => postMessage({ type: "error", message: "视频编码错误: " + err.message })
    })
    videoEncoder.configure(vConfig)
    postMessage({ type: "ready", audio: audioOk })
    return
  }

  if (msg.type == "frame") {
    // 背压
    while (videoEncoder.encodeQueueSize > 8) {
      await new Promise((r) => setTimeout(r, 4))
    }
    videoEncoder.encode(msg.frame, { keyFrame: !!msg.keyFrame })
    msg.frame.close()
    postMessage({ type: "ack" })
    return
  }

  if (msg.type == "flush-video") {
    await videoEncoder.flush()
    postMessage({ type: "video-done" })
    return
  }

  if (msg.type == "audio") {
    if (audioEncoder) audioEncoder.encode(msg.data)
    msg.data.close()
    postMessage({ type: "ack" })
    return
  }

  if (msg.type == "finish") {
    if (audioEncoder) await audioEncoder.flush()
    muxer.finalize()
    // 整个成品 buffer 转移回主线程
    postMessage({ type: "result", buffer: muxer.target.buffer }, [muxer.target.buffer])
    return
  }
}
