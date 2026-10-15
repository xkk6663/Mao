/* xiaozhi-plugin.js — 小智插件
 * 依赖：plugin-bus.js（window.__mioPluginBus）、pet-xz-audio.js（window.__mioPetXzAudio）
 * 行为：后端 xiaozhi agent enabled=true → 挂载（语音 WS 连接、气泡/活动指示恢复、菜单入口出现）
 *      enabled=false/停用 → 全部拆除（断语音、隐藏气泡、菜单入口消失、通知主进程关闭 chat 窗口）
 */
(function () {
  if (window.__mioXiaozhiPluginLoaded) return
  window.__mioXiaozhiPluginLoaded = true

  const bus = window.__mioPluginBus
  if (!bus) return

  function setXiaozhiUi(on) {
    const bubble = document.getElementById('speech-bubble')
    if (bubble) bubble.classList.toggle('plugin-off', !on)
    const indicator = document.getElementById('activity-indicator')
    if (indicator) indicator.classList.toggle('plugin-off', !on)
  }

  bus.register({
    id: 'xiaozhi',
    agentId: 'xiaozhi',
    name: '小智',
    menuItems: [
      { action: 'chat', label: '打开小智对话', order: 10 },
      { action: 'screenshot-ask', label: '截图提问', order: 20 },
      { action: 'speech-bubble', label: '隐藏说话气泡', order: 30 },
    ],
    onMount() {
      setXiaozhiUi(true)
      // 语音 WS：小智启用才连接（未启用零连接零音频）
      try { if (window.__mioPetXzAudio) window.__mioPetXzAudio.connect() } catch (_) {}
      // 通知主进程：小智已启用，chat 窗口入口开放
      try {
        if (window.mioDesktop && window.mioDesktop.setAgentPlugin) {
          window.mioDesktop.setAgentPlugin({ agentId: 'xiaozhi', enabled: true })
        }
      } catch (_) {}
      console.log('[plugin] xiaozhi mounted')
    },
    onUnmount() {
      setXiaozhiUi(false)
      // 断开语音 WS
      try { if (window.__mioPetXzAudio) window.__mioPetXzAudio.disconnect() } catch (_) {}
      // 通知主进程：小智停用，chat 窗口入口关闭
      try {
        if (window.mioDesktop && window.mioDesktop.setAgentPlugin) {
          window.mioDesktop.setAgentPlugin({ agentId: 'xiaozhi', enabled: false })
        }
      } catch (_) {}
      console.log('[plugin] xiaozhi unmounted')
    },
  })
})()
