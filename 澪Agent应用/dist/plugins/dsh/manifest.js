/* dsh plugin manifest — DSH 插件包声明（体检条目）
 * DSH 无专属前端导航（无 nav 关键词）；体检面板提供 DSH 自检条目
 */
window.__mioPluginManifests = window.__mioPluginManifests || {}
window.__mioPluginManifests['dsh'] = {
  agentId: 'dsh',
  name: 'DSH',
  nav: null,
  observeTab: false,
  health: true,
}
// 注册进前端微内核注册表（幂等）
if (window.__mioPluginRegistry) window.__mioPluginRegistry.register(window.__mioPluginManifests['dsh'])
