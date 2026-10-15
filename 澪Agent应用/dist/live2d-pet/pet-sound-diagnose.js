/* pet-sound-diagnose.js — 音效自检（桌宠窗口内运行，报告真实故障点）
 *
 * 为什么需要它：音效"没声音"有多种互斥原因，而我在开发侧**看不到**运行中的
 * Electron 窗口，只能靠猜。本模块把每一种可能原因都变成一条可读结论，
 * 让用户点一下就把真相贴回来，而不是反复试错。
 *
 * 用法：桌宠窗口里按 F12 打开控制台，执行
 *     await window.__mioPetSoundDiag()
 * 然后把输出贴回给开发。
 */
(function () {
  /* 生成一段极短的正弦 WAV（16bit/mono/8kHz），用于交叉验证 <audio> 链路。
     自行拼 wav 头而不是引入素材：保持本模块零依赖、零素材。 */
  function makeBeepWav(freq, seconds, sampleRate) {
    const rate = sampleRate || 8000
    const n = Math.max(1, Math.floor(rate * seconds))
    const dataSize = n * 2
    const buf = new ArrayBuffer(44 + dataSize)
    const view = new DataView(buf)
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE')
    writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
    view.setUint16(22, 1, true); view.setUint32(24, rate, true)
    view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    writeStr(36, 'data'); view.setUint32(40, dataSize, true)
    for (let i = 0; i < n; i++) {
      // 淡入淡出包络，避免起止爆音
      const env = Math.min(1, i / (rate * 0.01), (n - i) / (rate * 0.01))
      view.setInt16(44 + i * 2, Math.sin((2 * Math.PI * freq * i) / rate) * env * 12000, true)
    }
    return buf
  }

  window.__mioPetSoundDiag = async function () {
    const out = []
    const say = (k, v) => out.push(`${k}: ${v}`)

    // 1) 模块是否加载
    const api = window.__mioPetSound
    say('模块加载', api ? 'OK' : '缺失（pet-sound.js 没进来）')
    if (!api) return out.join('\n')

    // 2) AudioContext 构造能力
    const AC = window.AudioContext || window.webkitAudioContext
    say('AudioContext 可用', AC ? 'OK' : '不可用（容器不支持）')
    if (!AC) return out.join('\n')

    // 3) 上下文状态与采样率
    let ctx = null
    try {
      ctx = new AC()
      say('初始 state', ctx.state)
      say('sampleRate', ctx.sampleRate)
      say('destination.channelCount', ctx.destination.channelCount)
      say('baseLatency', ctx.baseLatency ?? '(无)')
    } catch (e) {
      say('构造失败', String(e && e.message))
      return out.join('\n')
    }

    // 4) resume 是否成功（自动播放策略）
    try {
      if (ctx.state === 'suspended') await ctx.resume()
      say('resume 后 state', ctx.state)
    } catch (e) {
      say('resume 失败', String(e && e.message))
    }

    // 5) 输出设备枚举（关键：0 个设备 = 系统层没声卡可用）
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const devs = await navigator.mediaDevices.enumerateDevices()
        const outs = devs.filter((d) => d.kind === 'audiooutput')
        say('系统输出设备数', outs.length)
        outs.forEach((d, i) => say(`  设备${i}`, d.label || '(无标签=未授权)'))
      } else {
        say('enumerateDevices', '不可用')
      }
    } catch (e) {
      say('enumerateDevices 失败', String(e && e.message))
    }

    // 6) 真实播一个音，并在 AnalyserNode 上测能量（能测到能量 = 信号确实送到了输出）
    try {
      const osc = ctx.createOscillator()
      const g = ctx.createGain()
      const an = ctx.createAnalyser()
      an.fftSize = 2048
      g.gain.value = 0.25
      osc.frequency.value = 880
      osc.connect(g); g.connect(an); an.connect(ctx.destination)
      osc.start()
      // 等 120ms 让音频跑起来再采样
      await new Promise((r) => setTimeout(r, 120))
      const buf = new Float32Array(an.fftSize)
      an.getFloatTimeDomainData(buf)
      let peak = 0
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]))
      say('测试音峰值能量', peak.toFixed(5) + (peak > 0.01 ? '  ← 信号已输出，链路通' : '  ← 无信号！'))
      osc.stop()
      say('播放后 state', ctx.state)
      say('播放后 currentTime', ctx.currentTime.toFixed(3))
    } catch (e) {
      say('测试音失败', String(e && e.message))
    }

    // 7) 我的模块内部状态
    try {
      say('模块 unlocked', api.isUnlocked())
      say('模块 enabled', api.isEnabled())
      say('模块 volume', api.getVolume())
      say('音色表', api.presets.join(','))
    } catch (e) {
      say('模块状态读取失败', String(e && e.message))
    }

    // 8) 播放一次内置音色（真实走我的代码路径）
    try {
      const ok = api.play('press')
      say('play(press) 返回', ok)
    } catch (e) {
      say('play 抛错', String(e && e.message))
    }

    // 9) 交叉验证：用 <audio> 播一段极短 WAV。
    //    这一条能把"Web Audio 这条链路坏了"与"整个 Chromium 都出不了声"区分开：
    //    · 两者都无声 → 环境层面（设备/系统静音/Chromium 音频栈）
    //    · 只有 Web Audio 无声 → 我方代码或 AudioContext 解锁问题
    try {
      const wav = makeBeepWav(880, 0.12)
      const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
      const el = new Audio(url)
      el.volume = 0.3
      const played = await new Promise((resolve) => {
        let settled = false
        const done = (v) => { if (!settled) { settled = true; resolve(v) } }
        el.addEventListener('playing', () => done('playing'))
        el.addEventListener('error', () => done('error:' + (el.error && el.error.code)))
        setTimeout(() => done('timeout'), 1500)
        const p = el.play()
        if (p && p.catch) p.catch((e) => done('reject:' + (e && e.name)))
      })
      say('HTMLAudio 播放', played + (played === 'playing' ? '  ← 这条链路是通的' : ''))
      URL.revokeObjectURL(url)
    } catch (e) {
      say('HTMLAudio 测试失败', String(e && e.message))
    }

    const text = out.join('\n')
    console.log('%c=== Mio 音效自检 ===', 'font-weight:bold')
    console.log(text)
    return text
  }

  /* 把自检结果画在**桌宠窗口内**（无需开 DevTools / 截图控制台即可回报）。
     为什么需要：桌宠是无边框置顶小窗，开发者工具不一定好开；
     直接在屏幕上显示结论，用户截个图就能把真实原因发回来。 */
  window.__mioPetSoundReport = async function () {
    const text = await window.__mioPetSoundDiag()
    let panel = document.getElementById('pet-sound-report')
    if (!panel) {
      panel = document.createElement('section')
      panel.id = 'pet-sound-report'
      panel.className = 'pet-sound-report'
      ;(document.getElementById('pet-root') || document.body).appendChild(panel)
      panel.addEventListener('pointerdown', (e) => e.stopPropagation())
      panel.addEventListener('click', (e) => {
        if (e.target && e.target.id === 'pet-sound-report-close') panel.hidden = true
      })
    }
    // 结论摘要：先给出"最可能的原因"，再列明细，省得用户自己读日志
    const lines = String(text).split('\n')
    const peakLine = lines.find((l) => l.indexOf('测试音峰值能量') === 0) || ''
    const devLine = lines.find((l) => l.indexOf('系统输出设备数') === 0) || ''
    const stateLine = lines.find((l) => l.indexOf('resume 后 state') === 0) || ''
    let verdict = '链路正常，应该能听到声音'
    if (/无信号/.test(peakLine) && /: 0$/.test(devLine)) {
      verdict = '系统没有可见的输出设备 → 属于环境问题，不是桌宠代码'
    } else if (/无信号/.test(peakLine)) {
      verdict = 'Web Audio 没输出信号 → 可能是 Chromium 音频栈或系统静音'
    } else if (/模块加载: 缺失/.test(text)) {
      verdict = '音效模块没加载 → 前端缓存或文件未更新'
    } else if (/suspended/.test(stateLine)) {
      verdict = 'AudioContext 没能解锁（自动播放策略）'
    }
    panel.innerHTML =
      '<header><strong>音效自检</strong>' +
      '<button type="button" id="pet-sound-report-close">✕</button></header>' +
      '<div class="pet-sound-report-verdict"></div>' +
      '<pre class="pet-sound-report-body"></pre>'
    panel.querySelector('.pet-sound-report-verdict').textContent = verdict
    panel.querySelector('.pet-sound-report-body').textContent = text
    panel.hidden = false
    return text
  }
})()
