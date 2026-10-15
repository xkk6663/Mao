/* pet-sound.js — 桌宠交互音效（A 档能力，桌宠侧自足）
 *
 * 定位：按压/释放/切换等交互的即时反馈音，让桌宠"上手有回应"。
 *
 * 设计要点：
 *   - **零素材依赖**：全部用 Web Audio 现场合成（振荡器 + 包络），
 *     不随包分发任何音频文件 ⇒ 没有素材许可问题，也不增加体积；
 *   - **零依赖**：只暴露 window.__mioPetSound，不引用任何插件；
 *   - **可配置**：开关与音量由后端桌宠设置驱动（pet_sound_enabled / pet_sound_volume）；
 *   - **不抢音频通道**：独立 AudioContext + 独立 gain，不与语音播报互相打断。
 *
 * 为什么合成而不是内置 mp3：本项目要 fork 出去独立分发，一旦打包第三方音效就
 * 必须逐个处理许可与出处（whale-widget 就为此单独写了 PROVENANCE.md）。
 * 合成音没有这个问题，且体积为 0。
 */
(function () {
  if (window.__mioPetSound) return

  var ctx = null
  var master = null
  var enabled = true
  var volume = 0.7          // 0..1
  var lastPlayAt = 0
  var MIN_GAP_MS = 45       // 连点去抖：避免快速点击叠成噪音
  var unlocked = false      // 音频上下文是否已被用户手势解锁

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
   *
   * 为什么必须单独做：Chromium 的自动播放策略让 AudioContext 初始为 'suspended'，
   * 且 resume() 是**异步**的。旧实现在播放时才调 resume，于是第一次点击时
   * currentTime 仍停在 0，而我们把音符调度在 t0=currentTime 上——等音频时钟真正
   * 跑起来时那个短音早已"过期"，表现就是**第一次点击没声音**（甚至因为每次点击
   * 都重建/复用未解锁的上下文而一直没声音）。
   *
   * 正确做法：在 pointerdown 的同步栈里就 resume 并播放一个**静音**振荡器，
   * 把上下文真正推入 running，之后的音效才听得到。
   */
  function unlock() {
    var c = ensureCtx()
    if (!c) return false
    try {
      if (c.state === 'suspended' && typeof c.resume === 'function') c.resume()
    } catch (_) {}
    if (!unlocked) {
      try {
        // 静音振荡器：把上下文推入 running（音量 0，不会出声）
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

  /** 播放一个带包络的音（现场合成，无外部素材）。 */
  function tone(opts) {
    if (!enabled) return false
    var now = Date.now()
    if (now - lastPlayAt < MIN_GAP_MS) return false
    lastPlayAt = now

    var c = ensureCtx()
    if (!c || !master) return false
    // 已解锁则直接用；未解锁时**先解锁再播**（路径上仍带 resume，最大化成功率）
    if (!unlocked) unlock()
    if (c.state === 'suspended') { try { c.resume() } catch (_) {} }

    var t0 = c.currentTime
    // 关键：调度点加 12ms 提前量。裸 t0 在上下文刚 resume 时可能已经落在过去，
    // 导致整段音被 Web Audio 丢弃（听不见）。小的前瞻量能稳定播出。
    t0 += 0.012
    var dur = Math.max(0.03, Number(opts.duration) || 0.09)
    var osc = c.createOscillator()
    var gain = c.createGain()
    osc.type = opts.type || 'sine'
    osc.frequency.setValueAtTime(Number(opts.from) || 660, t0)
    if (opts.to) osc.frequency.exponentialRampToValueAtTime(Math.max(1, opts.to), t0 + dur)
    // 快起慢落包络：避免爆音（不加坡度的方波/正弦直接切会"啪"一声）
    var peak = Math.max(0.0001, (Number(opts.gain) || 0.16))
    gain.gain.setValueAtTime(0.0001, t0)
    gain.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.012, dur * 0.3))
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)

    osc.connect(gain)
    gain.connect(master)
    osc.start(t0)
    osc.stop(t0 + dur + 0.02)
    return true
  }

  // 预置音色：每种交互一个可辨认的短音
  var PRESETS = {
    // 按压：上扬短音（"我听到你了"）
    press: function () { return tone({ from: 620, to: 880, duration: 0.075, gain: 0.15, type: 'sine' }) },
    // 释放：回落短音
    release: function () { return tone({ from: 760, to: 520, duration: 0.085, gain: 0.12, type: 'sine' }) },
    // Agent 切换：双音（"换人了"）
    switch: function () {
      tone({ from: 700, to: 700, duration: 0.06, gain: 0.12, type: 'triangle' })
      window.setTimeout(function () { tone({ from: 980, to: 980, duration: 0.08, gain: 0.12, type: 'triangle' }) }, 70)
      return true
    },
    // 完成：三音上行（"搞定"）
    done: function () {
      tone({ from: 660, to: 660, duration: 0.07, gain: 0.13, type: 'sine' })
      window.setTimeout(function () { tone({ from: 880, to: 880, duration: 0.07, gain: 0.13, type: 'sine' }) }, 80)
      window.setTimeout(function () { tone({ from: 1180, to: 1180, duration: 0.12, gain: 0.13, type: 'sine' }) }, 165)
      return true
    },
    // 异常：下沉双音（"出问题了"）
    error: function () {
      tone({ from: 320, to: 300, duration: 0.14, gain: 0.15, type: 'sawtooth' })
      window.setTimeout(function () { tone({ from: 240, to: 220, duration: 0.18, gain: 0.14, type: 'sawtooth' }) }, 130)
      return true
    },
  }

  window.__mioPetSound = {
    play: function (name) {
      var fn = PRESETS[String(name || '')]
      return fn ? fn() : false
    },
    // 供桌宠在 pointerdown 的同步栈里调用（解锁音频），必须在用户手势内
    unlock: unlock,
    isUnlocked: function () { return unlocked },
    setEnabled: function (on) { enabled = !!on },
    isEnabled: function () { return enabled },
    setVolume: function (v) {
      volume = Math.max(0, Math.min(1, Number(v) / (Number(v) > 1 ? 100 : 1)))
      if (master) { try { master.gain.value = volume } catch (_) {} }
    },
    getVolume: function () { return volume },
    presets: Object.keys(PRESETS),
    // 供自检断言：不实际出声也能验证音色表存在
    has: function (name) { return Object.prototype.hasOwnProperty.call(PRESETS, String(name)) },
  }
})()
