/* octop plugin manifest — Octop 插件包声明（体检条目）
 * Octop 默认停用；无专属前端导航；体检面板提供 Octop 自检条目
 */
window.__mioPluginManifests = window.__mioPluginManifests || {}
window.__mioPluginManifests['octop'] = {
  agentId: 'octop',
  name: 'Octop',
  nav: null,
  observeTab: false,
  health: true,
}
