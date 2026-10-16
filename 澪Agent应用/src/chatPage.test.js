import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const chatPageSource = fs.readFileSync(path.join(root, 'components', 'ChatPage.vue'), 'utf8')
const appSource = fs.readFileSync(path.join(root, 'App.vue'), 'utf8')
const conversationSource = fs.readFileSync(path.join(root, 'composables', 'useConversations.js'), 'utf8')
const chatCssSource = fs.readFileSync(path.join(root, 'styles', 'chat.css'), 'utf8')
const agentCssSource = fs.readFileSync(path.join(root, 'styles', 'agent-workspace.css'), 'utf8')
const integratedCssSource = fs.readFileSync(path.join(root, 'styles', 'integrated.css'), 'utf8')
const companionPageSource = fs.readFileSync(path.join(root, 'components', 'CompanionPage.vue'), 'utf8')
const petAppearanceSource = fs.readFileSync(path.join(root, 'components', 'PetAppearancePanel.vue'), 'utf8')
const settingsPageSource = fs.readFileSync(path.join(root, 'components', 'SettingsPage.vue'), 'utf8')

test('unpinned conversation drawer closes from the outside backdrop', () => {
  assert.match(chatPageSource, /conversationDrawerOpen && !conversationDrawerPinned/)
  assert.match(chatPageSource, /class="conversation-drawer-backdrop"/)
  assert.match(chatPageSource, /@click="conversationDrawerOpen = false"/)
  assert.match(integratedCssSource, /\.conversation-drawer-backdrop \{[^}]*z-index: 11;[^}]*inset: 0;/)
})

test('QQ shared conversation supports selecting individual messages to delete', () => {
  assert.match(chatPageSource, /title="选择要清理的 QQ 消息"/)
  assert.match(chatPageSource, /deleteSelectedQqMessages/)
  assert.match(chatPageSource, /context\.deleteConversationMessages/)
})

// 小智对话已接管消息区与输入区（见 docs/M2-2.1-小智对话历史-回写规范.md）。
// 原版 context.messageTurns 渲染分支被替换，故断言改为核验小智链路的真实契约。
test('xiaozhi conversation takes over the message list and composer', () => {
  assert.match(chatPageSource, /v-for="\(turn, index\) in xzMessages"/)
  assert.match(chatPageSource, /v-model="xzDraft"/)
  assert.match(chatPageSource, /@click="sendXzMessage"/)
  assert.match(chatPageSource, /class="sys-msg"/)
  assert.match(chatPageSource, /:class="\['xz-link-status', \{ connected: xzConnected \}\]"/)
  assert.doesNotMatch(chatPageSource, /v-model="context\.draft"/)
  assert.doesNotMatch(chatPageSource, /context\.messageTurns/)
  // 上下文外壳必须保留
  assert.match(chatPageSource, /conversation-drawer/)
  assert.match(chatPageSource, /mio_chat_follow/)
})

test('xiaozhi client wires history polling, ws and dual dedup', () => {
  assert.match(chatPageSource, /\/api\/xiaozhi\/chat-history\?limit=\$\{full \? 1000 : 100\}/)
  assert.match(chatPageSource, /setInterval\(\(\) => loadXzHistory\(false\), 3000\)/)
  assert.match(chatPageSource, /ws:\/\/\$\{location\.host\}\/api\/xiaozhi\/ws\?role=chat/)
  // 四条去重/过滤规则
  assert.match(chatPageSource, /text\.includes\('重连'\) \|\| text\.includes\('连接中断'\)/)
  assert.match(chatPageSource, /if \(id && seenIds\.has\(id\)\) continue/)
  assert.match(chatPageSource, /text\.startsWith\(existing\.text\) \|\| existing\.text\.startsWith\(text\)/)
  assert.match(chatPageSource, /item\.type !== 'image' && seenFp\.has/)
  // 二进制音频帧协议
  assert.match(chatPageSource, /view\.getUint32\(0, true\)/)
  assert.match(chatPageSource, /createBuffer\(channels, rate, 48000\)/)
  assert.match(chatPageSource, /Math\.min\(15000, Math\.round\(xzReconnectDelay \* 1\.6\)\)/)
})

test('ordinary chat hides Agent execution receipts and cannot enable creation tools', () => {
  assert.doesNotMatch(chatPageSource, /message-tool-receipts/)
  assert.doesNotMatch(chatPageSource, /creation-tools-toggle/)
  assert.match(conversationSource, /creation_tools_enabled:\s*deps\.isAgentWorkspace/)
  assert.match(conversationSource, /mode:\s*deps\.isAgentWorkspace \? 'agent' : 'companion'/)
  assert.doesNotMatch(appSource, /isAgentWorkspace \|\| creationToolsEnabled/)
})

test('chat images open in an in-app large preview instead of a raw browser tab', () => {
  assert.match(chatPageSource, /<ImagePreview v-if="activeImageAttachment"/)
  assert.doesNotMatch(chatPageSource, /target="_blank"/)
  // 小智历史里的图片与附件预览共用应用内大图查看器
  assert.match(chatPageSource, /turn\.image/)
  assert.match(chatCssSource, /\.message-attachment\.image\s*\{[^}]*width:\s*fit-content;/)
  assert.match(chatCssSource, /\.message-attachment\.image img\s*\{[^}]*width:\s*auto;[^}]*height:\s*auto;/)
  assert.doesNotMatch(chatCssSource, /\.message-attachment\.image img\s*\{[^}]*background:\s*#eef2f2;/)
  assert.match(agentCssSource, /\.agent-workspace-shell \.message-attachment\.image\s*\{[^}]*width:\s*fit-content;/)
  assert.match(agentCssSource, /\.agent-workspace-shell \.message-attachment\.image img\s*\{[^}]*width:\s*auto;[^}]*height:\s*auto;/)
  assert.match(chatCssSource, /\.chat-image-lightbox\s*\{[^}]*position:\s*fixed;/)
  assert.match(chatCssSource, /\.sys-msg\s*\{[^}]*text-align:\s*center;/)
  assert.match(chatCssSource, /\.xz-link-status\.connected:before\s*\{[^}]*background:\s*#5ee08a;/)
})

test('Live2D management panel wires refresh and model actions through its page context', () => {
  for (const event of ['select-live2d', 'refresh-status', 'import-live2d', 'delete-live2d', 'replace-live2d-preview', 'preview-motion', 'preview-expression']) {
    assert.match(petAppearanceSource, new RegExp(`['\"]${event}['\"]`))
  }
  assert.match(companionPageSource, /management-mode/)
  assert.match(companionPageSource, /@refresh-status="applyRefreshedStatus"/)
  assert.match(companionPageSource, /@select-live2d="switchModel"/)
  assert.match(settingsPageSource, /@refresh-status="applyRefreshedStatus"/)
  assert.match(settingsPageSource, /applyRefreshedStatus\(data\)/)
  assert.match(appSource, /provide\('mio-companion-page',[\s\S]*?importLive2DModel,[\s\S]*?deleteLive2DModel,[\s\S]*?replaceLive2DPreview,/)
})

test('companion busy and status-loading flags recover from stale requests', () => {
  assert.match(appSource, /Date\.now\(\) - companionBusySince > 10_000/)
  assert.match(appSource, /window\.setTimeout\([\s\S]*?10_050\)/)
  assert.match(appSource, /Date\.now\(\) - companionStatusLoadingSince > 8_000/)
})
