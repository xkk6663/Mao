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

    const text = out.join('\n')
    console.log('%c=== Mio 音效自检 ===', 'font-weight:bold')
    console.log(text)
    return text
  }
})()
