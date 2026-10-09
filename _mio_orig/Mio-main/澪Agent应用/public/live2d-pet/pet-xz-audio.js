/* pet-xz-audio.js — 桌宠主窗直连本地代理 /api/xiaozhi/ws，被动接收小智语音并播放
 * 解决"观察评价有文字但无声音"：此前音频只转发给对话浮窗订阅者，浮窗未开时消息被丢弃。
 * 现在桌宠主窗常驻订阅：浮窗开着 → 音频去浮窗（活跃订阅者优先）；浮窗没开 → 桌宠主窗播放。
 * 断连/重连静默处理，不打扰气泡。口型通过 CustomEvent('mio-xz-speaking') 通知 live2d-pet.js。
 */
(function () {
  if (window.__mioPetXzAudioLoaded) return
  window.__mioPetXzAudioLoaded = true

  // ---- DOM ----
  var bubbleEl = document.getElementById('speech-bubble')
  var bubbleTextEl = document.getElementById('speech-bubble-text')
  var bubbleHideTimer = null

  // ---- 音频播放（48kHz 双声道 float32 planar，后端代理解码后的 PCM）----
  var audioCtx = null
  var playQueue = []
  var playing = false
  var nextStartTime = 0
  var activeSources = new Set()

  function ensureAudioCtx() {
    if (!audioCtx) {
      var AC = window.AudioContext || window.webkitAudioContext
      if (AC) { try { audioCtx = new AC() } catch (e) { audioCtx = null } }
    }
    if (audioCtx && audioCtx.state === 'suspended') { try { audioCtx.resume() } catch (e) {} }
    return audioCtx
  }
  function pump() {
    if (!audioCtx || playing || playQueue.length === 0) return
    playing = true
    while (playQueue.length > 0) {
      var buf = playQueue.shift()
      var src = audioCtx.createBufferSource()
      src.buffer = buf
      src.connect(audioCtx.destination)
      var now = audioCtx.currentTime
      if (nextStartTime < now + 0.03) nextStartTime = now + 0.03
      src.start(nextStartTime)
      nextStartTime += buf.duration
      src.onended = function () { activeSources.delete(src); try { src.disconnect() } catch (e) {} }
      activeSources.add(src)
    }
    playing = false
  }
  function stopPlayback() {
    for (var s of activeSources) { try { s.onended = null; s.stop() } catch (e) {} }
    activeSources.clear()
    playQueue = []; playing = false; nextStartTime = 0
  }
  function handlePcm(data) {
    var ctx = ensureAudioCtx()
    if (!ctx || data.byteLength < 8) return
    var view = new DataView(data, 0, data.byteLength)
    var samples = view.getUint32(0, true)
    var channels = view.getUint32(4, true)
    if (samples < 1 || channels < 1 || channels > 8) return
    var frameBytes = samples * 4
    if (8 + frameBytes * channels > data.byteLength) return
    var buffer = ctx.createBuffer(channels, samples, 48000)
    for (var c = 0; c < channels; c++) {
      var off = 8 + c * frameBytes
      buffer.copyToChannel(new Float32Array(data, off, samples), c)
    }
    playQueue.push(buffer)
    pump()
  }

  // ---- 气泡（复用桌宠主窗现有 bubble DOM）----
  function showBubble(text) {
    if (!bubbleEl || !bubbleTextEl) return
    bubbleTextEl.textContent = text || ''
    bubbleEl.hidden = false
    window.clearTimeout(bubbleHideTimer)
    bubbleHideTimer = window.setTimeout(hideBubble, Math.max(4000, (text || '').length * 180))
  }
  function hideBubble() {
    window.clearTimeout(bubbleHideTimer)
    if (bubbleEl) bubbleEl.hidden = true
  }

  // ---- 口型通知（live2d-pet.js 监听 mio-xz-speaking）----
  function setSpeaking(active, durationMs) {
    try {
      window.dispatchEvent(new CustomEvent('mio-xz-speaking', { detail: { active: !!active, durationMs: durationMs || 5000 } }))
    } catch (e) {}
  }

  // ---- WebSocket（本地代理 → 小智官方云）----
  var ws = null
  var reconnectTimer = null
  var retryDelay = 3000
  var sessionId = ''

  function connect() {
    var url = 'ws://' + location.host + '/api/xiaozhi/ws'
    var wsTry
    try { wsTry = new WebSocket(url) } catch (e) { scheduleReconnect(); return }
    ws = wsTry
    ws.binaryType = 'arraybuffer'
    ws.onopen = function () { retryDelay = 3000 }
    ws.onclose = function () { ws = null; scheduleReconnect() }
    ws.onerror = function () {}
    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') handleText(ev.data)
      else handlePcm(ev.data)
    }
  }
  function scheduleReconnect() {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = window.setTimeout(connect, retryDelay)
    retryDelay = Math.min(15000, Math.round(retryDelay * 1.6))
  }

  function handleText(raw) {
    var j
    try { j = JSON.parse(raw) } catch (e) { return }
    if (!j || typeof j !== 'object') return
    switch (j.type) {
      case 'hello':
        sessionId = j.session_id || ''
        retryDelay = 3000
        break
      case 'llm':
        // 思考中/回答文本：短暂显示，不打断已播放语音
        if (j.emotion) setEmotion(j.emotion)
        break
      case 'tts':
        if (j.state === 'start') {
          stopPlayback()
          setSpeaking(true, 5000)
        } else if (j.state === 'sentence_start' && j.text) {
          showBubble(j.text)
          setSpeaking(true, Math.max(4000, j.text.length * 190))
        } else if (j.state === 'stop') {
          stopPlayback()
          setSpeaking(false)
          hideBubble()
        }
        break
      case 'error':
        // 断连/重连静默，不弹气泡打扰
        break
      default: break
    }
  }

  // ---- 表情（小智 emotion → 桌宠表情）----
  function setEmotion(emotion) {
    try {
      window.dispatchEvent(new CustomEvent('mio-xz-emotion', { detail: { emotion: emotion || '' } }))
    } catch (e) {}
  }

  connect()
})()
