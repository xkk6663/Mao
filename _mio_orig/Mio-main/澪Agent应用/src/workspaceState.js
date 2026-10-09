export function normalizeAgentView(view) {
  if (['creation', 'creation-image', 'creation-video'].includes(view)) return 'chat'
  // Agent 工作台不保留首页（工作台首页已阉割），默认直达桌宠中心
  return ['chat', 'tasks', 'settings', 'companion'].includes(view) ? view : 'companion'
}

export function filterConversationsForWorkspace(conversations, workspace) {
  const items = Array.isArray(conversations) ? conversations : []
  return items.filter((item) => (
    workspace === 'agent' ? item?.kind === 'agent' : item?.kind !== 'agent'
  ))
}
