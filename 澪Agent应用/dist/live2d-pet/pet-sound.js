/* pet-sound.js — 桌宠音效系统（可替换片段的事件化音效）
 *
 * 定位：交互事件（按压/松开/Agent切换/任务结束/提问/授权/异常）的即时反馈音。
 *   - **默认零素材依赖**：全部用 Web Audio 现场合成（振荡器 + 包络），随包不分发音频；
 *   - **可按事件替换**：每个事件可绑定自导入的音频片段（sounds/ 目录，管理页
 *     「泡泡 → 音效」上传/裁剪），播放时优先片段、无片段回退合成音；
 *   - **每事件独立开关与音量**：事件配置来自 settings.pet_sound_events；
 *     总开关 pet_sound_enabled + 基准音量 pet_sound_volume 仍在；
 *   - **零依赖**：只暴露 window.__mioPetSound，不引用任何插件；
 *   - **不抢音频通道**：独立 AudioContext + 独立 gain，不与语音播报互相打断。
 */
(function () {
  if (window.__mioPetSound) return

  var ctx = null
  var master = null
  var enabled = true
  var volume = 0.7          // 0..1，基准音量（总）
  var events = {}           // {event: {enabled, volume, clip}}
  var clips = []            // [{name,url,mtime}]
  var clipBuffers = {}      // name -> AudioBuffer（解码缓存）
  var lastPlayAt = 0
  var MIN_GAP_MS = 45       // 连点去抖：避免快速点击叠成噪音
  var unlocked = false      // 音频上下文是否已被用户手势解锁

  // 事件 → 合成音音色（无自定义片段时的回退；也是"内置音效"）
  var EVENT_PRESET = {
    press: 'press',
    release: 'release',
    switch: 'switch',
    task_end: 'done',
    ask: 'ask',
    approval: 'approval',
    error: 'error',
  }

  function ensureCtx() {
    if (ctx) return ctx
    try {
      var AC = window.AudioContext || window.webkitAudioContext
      if (!AC) return null
      ctx = new AC()
      master = ctx.createGain()
      master.gain.value = volume
      master.connect(ctx.destination)
    } catch (_) {
      ctx = null
    }
    return ctx
  }

  /**
   * 提前解锁音频上下文（必须在**用户手势**的同步调用栈里执行）。
   * Chromium 自动播放策略让 AudioContext 初始 suspended，且 resume() 是异步的；
   * 在 pointerdown 同步栈里 resume + 播一个静音振荡器，后续音效才听得到。
   */
  function unlock() {
    var c = ensureCtx()
    if (!c) return false
    try {
      if (c.state === 'suspended' && typeof c.resume === 'function') c.resume()
    } catch (_) {}
    if (!unlocked) {
      try {
        var osc = c.createOscillator()
        var g = c.createGain()
        g.gain.value = 0
        osc.connect(g)
        g.connect(c.destination)
        osc.start(0)
        osc.stop(c.currentTime + 0.01)
      } catch (_) {}
      unlocked = true
    }
    return true
  }

  /** 事件的有效音量（0..1）：事件音量百分比 × 基准音量。 */
  function eventGain(eventName) {
    var cfg = events[eventName] || {}
    var pct = Number(cfg.volume)
    var evVol = Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : 1
    return evVol * volume
  }

  /** 播放一个带包络的合成音（现场合成，无外部素材）。 */
  function tone(opts, gainScale) {
    var now = Date.now()
    if (now - lastPlayAt < MIN_GAP_MS) return false
    lastPlayAt = now

    var c = ensureCtx()
    if (!c || !master) return false
    if (!unlocked) unlock()
    if (c.state === 'suspended') { try { c.resume() } catch (_) {} }

    var t0 = c.currentTime + 0.012   // 12ms 前瞻：上下文刚 resume 时裸 t0 可能落在过去
    var dur = Math.max(0.03, Number(opts.duration) || 0.09)
    var osc = c.createOscillator()
    var gain = c.createGain()
    osc.type = opts.type || 'sine'
    osc.frequency.setValueAtTime(Number(opts.from) || 660, t0)
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), t0 + dur)
    var peak = Math.max(0.0001, (Number(opts.gain) || 0.16) * (Number(gainScale) || 1))
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.012, dur * 0.3))
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)

    osc.connect(gain)
    gain.connect(master)
    osc.start(t0)
    osc.stop(t0 + dur + 0.02)
    return true
  }

  // 预置音色：每种事件一个可辨认的短音（也是"内置音效"选项）
  var PRESETS = {
    // 按压：上扬短音（"我听到你了"）
    press: function (g) { return tone({ from: 620, to: 880, duration: 0.075, gain: 0.15, type: 'sine' }, g) },
    // 松开：回落短音
    release: function (g) { return tone({ from: 760, to: 520, duration: 0.085, gain: 0.12, type: 'sine' }, g) },
    // Agent 切换：双音（"换人了"）
    switch: function (g) {
      tone({ from: 700, to: 700, duration: 0.06, gain: 0.12, type: 'triangle' }, g)
      window.setTimeout(function () { tone({ from: 980, to: 980, duration: 0.08, gain: 0.12, type: 'triangle' }, g) }, 70)
      return true
    },
    // 任务结束：三音上行（"搞定"）
    done: function (g) {
      tone({ from: 660, to: 660, duration: 0.07, gain: 0.13, type: 'sine' }, g)
      window.setTimeout(function () { tone({ from: 880, to: 880, duration: 0.07, gain: 0.13, type: 'sine' }, g) }, 80)
      window.setTimeout(function () { tone({ from: 1180, to: 1180, duration: 0.12, gain: 0.13, type: 'sine' }, g) }, 165)
      return true
    },
    // 提问：两声疑问上扬（"要回答我哦"）
    ask: function (g) {
      tone({ from: 720, to: 1080, duration: 0.09, gain: 0.13, type: 'sine' }, g)
      window.setTimeout(function () { tone({ from: 900, to: 1180, duration: 0.11, gain: 0.12, type: 'sine' }, g) }, 110)
      return true
    },
    // 授权：单声清脆提示（"等你点头"）
    approval: function (g) {
      tone({ from: 1040, to: 1040, duration: 0.08, gain: 0.13, type: 'triangle' }, g)
      window.setTimeout(function () { tone({ from: 1320, to: 1320, duration: 0.1, gain: 0.11, type: 'triangle' }, g) }, 95)
      return true
    },
    // 异常：下沉双音（"出问题了"）
    error: function (g) {
      tone({ from: 320, to: 300, duration: 0.14, gain: 0.15, type: 'sawtooth' }, g)
      window.setTimeout(function () { tone({ from: 240, to: 220, duration: 0.18, gain: 0.14, type: 'sawtooth' }, g) }, 130)
      return true
    },
  }

  function clipUrl(name) {
    var found = null
    clips.forEach(function (c) { if (c.name === name) found = c })
    return found ? found.url + '?v=' + found.mtime : ('/api/companion/sounds/' + encodeURIComponent(name))
  }

  /** 播放自定义片段（解码缓存 + 事件音量）。 */
  function playClip(clipName, gainScale) {
    var c = ensureCtx()
    if (!c || !master) return false
    if (c.state === 'suspended') { try { c.resume() } catch (_) {} }
    var cached = clipBuffers[clipName]
    var start = function (buffer) {
      try {
        var src = c.createBufferSource()
        var g = c.createGain()
        src.buffer = buffer
        g.gain.value = Math.max(0.0001, (Number(gainScale) || 1))
        src.connect(g)
        g.connect(master)
        src.start(c.currentTime + 0.008)
        return true
      } catch (_) { return false }
    }
    if (cached) return start(cached)
    fetch(clipUrl(clipName))
      .then(function (r) { return r.arrayBuffer() })
      .then(function (buf) { return c.decodeAudioData(buf) })
      .then(function (audioBuf) {
        clipBuffers[clipName] = audioBuf
        start(audioBuf)
      })
      .catch(function () {})
    return true
  }

  /** 事件播放：有绑定片段用片段，否则回退合成音；事件关掉则不响。 */
  function play(eventName) {
    if (!enabled) return false
    var name = String(eventName || '')
    var cfg = events[name]
    if (cfg && cfg.enabled === false) return false
    var scale = eventGain(name)
    if (scale <= 0) return false
    var clip = cfg && typeof cfg.clip === 'string' ? cfg.clip.trim() : ''
    if (clip) return playClip(clip, scale)
    var preset = EVENT_PRESET[name] || name
    var fn = PRESETS[preset]
    return fn ? fn(scale) : false
  }

  /** 试听（忽略事件开关；事件音量为 0 时回退基准音量，保证"听得到"）。 */
  function preview(eventName) {
    var name = String(eventName || '')
    var cfg = events[name] || {}
    var clip = typeof cfg.clip === 'string' ? cfg.clip.trim() : ''
    var scale = eventGain(name)
    if (!(scale > 0)) scale = volume
    if (clip) return playClip(clip, scale)
    var preset = EVENT_PRESET[name] || name
    var fn = PRESETS[preset]
    return fn ? fn(scale) : false
  }

  function setEvents(next) {
    events = (next && typeof next === 'object') ? JSON.parse(JSON.stringify(next)) : {}
  }

  function setClips(list) {
    clips = Array.isArray(list) ? list.slice() : []
  }

  function refreshClips() {
    return fetch('/api/companion/sounds', { headers: { 'Cache-Control': 'no-cache' } })
      .then(function (r) { return r.json() })
      .then(function (j) { setClips((j && j.sounds) || []); return clips })
      .catch(function () { return clips })
  }

  window.__mioPetSound = {
    // 事件化播放（推荐入口）
    play: play,
    preview: preview,
    // 兼容旧调用（直接按音色名播）
    playPreset: function (name) {
      var fn = PRESETS[String(name || '')]
      return fn ? fn(1) : false
    },
    unlock: unlock,
    isUnlocked: function () { return unlocked },
    setEnabled: function (on) { enabled = !!on },
    isEnabled: function () { return enabled },
    setVolume: function (v) {
      volume = Math.max(0, Math.min(1, Number(v) / (Number(v) > 1 ? 100 : 1)))
      if (master) { try { master.gain.value = volume } catch (_) {} }
    },
    getVolume: function () { return volume },
    setEvents: setEvents,
    getEvents: function () { return JSON.parse(JSON.stringify(events)) },
    setClips: setClips,
    refreshClips: refreshClips,
    getClips: function () { return clips.slice() },
    events: Object.keys(EVENT_PRESET),
    presets: Object.keys(PRESETS),
    has: function (name) { return Object.prototype.hasOwnProperty.call(PRESETS, String(name)) },
  }
})()
