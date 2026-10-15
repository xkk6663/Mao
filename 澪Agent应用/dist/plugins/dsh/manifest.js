/* dsh plugin manifest — DSH 插件包声明（导航 / 体检条目）
 * 加载顺序：manifest.js 必须先于 kernel/plugin-registry.js 与 kernel/plugin-nav.js（index.html 引用序保证）
 * 状态口径：以后端 /api/companion/agents 的 enabled 为准（与桌宠插件总线同源）
 * 插件零相互依赖：本文件只声明自己，不引用其它插件的任何东西。
 */
window.__mioPluginManifests = window.__mioPluginManifests || {}
window.__mioPluginManifests['dsh'] = {
  agentId: 'dsh',
  name: 'DSH',
  // 左侧导航关键词：DSH 启用时显示「DSH」导航项，停用时由 kernel/plugin-nav.js 隐藏
  nav: { keywords: ['DSH'] },
  // 桌宠页「观察」子 tab 为小智专有，本插件不声明
  observeTab: false,
  // 体检面板：本插件声明自己的自检条目（/api/plugin/dsh/diagnostics）
  health: true,
  // 桌宠气泡配色键：与其它插件的气泡在视觉上区分（本插件 = 靛蓝）
  bubble: { colorKey: 'dsh', accent: '#4F6BED' },
}
// 注册进前端微内核注册表（幂等）
if (window.__mioPluginRegistry) window.__mioPluginRegistry.register(window.__mioPluginManifests['dsh'])
