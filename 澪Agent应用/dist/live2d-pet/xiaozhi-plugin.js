/* xiaozhi-plugin.js — 小智插件
 * 依赖：plugin-bus.js（window.__mioPluginBus）、pet-xz-audio.js（window.__mioPetXzAudio）
 * 行为：enabled=true → 挂载（语音 WS 连接、菜单入口出现、通知主进程开放 chat 窗口）
 *      enabled=false/停用 → 全部拆除（断语音、菜单入口消失、通知主进程关闭 chat 窗口）
 *
 * ⚠️ 插件边界（一切皆插件，互不依赖）：
 *   说话气泡(#speech-bubble) / 活动指示器(#activity-indicator) 是**桌宠主体能力**，
 *   任何插件（含本插件）都不得隐藏/接管——它们同时服务于点击互动、空闲自语、
 *   其它插件消息与 DSH 气泡。历史 bug：本插件曾在停用时给这两个元素加 .plugin-off，
 *   导致"关掉小智插件 → 泡泡全没了"。核心 UI 的显隐只由核心设置控制
 *   （live2d_speech_bubble_enabled 等），插件只声明**自己的**菜单项与资源。
 */
(function () {
  if (window.__mioXiaozhiPluginLoaded) return
  window.__mioXiaozhiPluginLoaded = true

  const bus = window.__mioPluginBus
  if (!bus) return

  bus.register({
    id: 'xiaozhi',
    agentId: 'xiaozhi',
    name: '小智',
    // 只声明本插件自己的入口；「隐藏说话气泡」是核心能力，由核心菜单提供，插件不重复占位
    menuItems: [
      { action: 'chat', label: '打开小智对话', order: 10 },
      { action: 'screenshot-ask', label: '截图提问', order: 20 },
    ],
    onMount() {
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
