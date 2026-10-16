<script setup>
import AgentTasksPage from './AgentTasksPage.vue'
import ImagePreview from './ImagePreview.vue'
import { computed, inject, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  FileText,
  Wrench,
  ListChecks,
  MessageSquareText,
  Pin,
  Plus,
  Send,
  SquarePen,
  Trash2,
  Upload,
  UserRound,
  X,
} from '@lucide/vue'

const context = inject('mio-chat-page')
if (!context) throw new Error('对话页上下文未初始化')
const conversationDrawerOpen = ref(false)
const conversationDrawerPinned = ref(localStorage.getItem('mio_conversation_drawer_pinned') === 'true')
const qqCleanupMode = ref(false)
const selectedQqMessageIds = ref([])
const activeImageAttachment = ref(null)
const agentProcessExpanded = ref(localStorage.getItem('mio_agent_process_expanded') !== 'false')
const activeConversation = computed(() => context.conversations.find((item) => item.id === context.selectedConversationId) || null)

async function openConversation(conversationId) {
  if (conversationId !== context.selectedConversationId) cancelQqCleanup()
  await context.selectConversation(conversationId)
  if (!conversationDrawerPinned.value) conversationDrawerOpen.value = false
}

async function beginQqCleanup(conversation) {
  if (context.sending) return
  await openConversation(conversation.id)
  selectedQqMessageIds.value = []
  qqCleanupMode.value = true
}

function cancelQqCleanup() {
  qqCleanupMode.value = false
  selectedQqMessageIds.value = []
}

function toggleQqMessage(messageId) {
  const id = Number(messageId)
  if (!Number.isInteger(id) || id <= 0) return
  selectedQqMessageIds.value = selectedQqMessageIds.value.includes(id)
    ? selectedQqMessageIds.value.filter((item) => item !== id)
    : [...selectedQqMessageIds.value, id]
}

async function deleteSelectedQqMessages() {
  if (!activeConversation.value || !selectedQqMessageIds.value.length) return
  const deleted = await context.deleteConversationMessages(activeConversation.value, selectedQqMessageIds.value)
  if (deleted) cancelQqCleanup()
}

function toggleConversationDrawerPin() {
  conversationDrawerPinned.value = !conversationDrawerPinned.value
  localStorage.setItem('mio_conversation_drawer_pinned', String(conversationDrawerPinned.value))
}

function openImagePreview(attachment) {
  if (!attachment?.url) return
  activeImageAttachment.value = attachment
}

function closeImagePreview() {
  activeImageAttachment.value = null
}

/* ---------------------------------------------------------------------------
 * 小智对话（承载方式：接管消息区与输入区，与 dist 既有实现逐字节对齐）
 * 数据：GET /api/xiaozhi/chat-history（历史）+ WS /api/xiaozhi/ws?role=chat（实时）
 * 发送：文本经 WS listen 事件；音频走 WS 二进制帧（自定义头 + float32 PCM）
 * 详见 docs/M2-2.1-小智对话历史-回写规范.md
 * ------------------------------------------------------------------------- */
const desktopBridge = window.mioDesktop || {}

function scrollToBottom() {
  const element = context.chatScroll
  if (element) element.scrollTop = element.scrollHeight
}

const followChat = ref(localStorage.getItem('mio_chat_follow') !== 'false')
const xzConnected = ref(false)      // R：小智 WS 连通
const xzMessages = ref([])          // z：小智消息列表
const xzDraft = ref('')             // B：小智输入框
const xzThinking = ref(false)       // V：小智思考中
let xzSessionId = ''                // H：小智 session_id
let xzSocket = null                 // U：小智 WebSocket
let xzReconnectTimer = null         // W
let xzReconnectDelay = 3000         // G：指数退避，hello 时重置

// 去重集合
let seenIds = new Set()
let seenFp = new Set()

// 音频播放（独立 AudioContext + 顺序队列）
let audioCtx = null
let audioQueue = []
let audioPlaying = false
let audioNextTime = 0
const audioSources = new Set()

watch([xzMessages, xzThinking], () => {
  if (followChat.value) nextTick(scrollToBottom)
}, { flush: 'post' })

function resumeAudio() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (Ctor) { try { audioCtx = new Ctor() } catch { audioCtx = null } }
  }
  if (audioCtx && audioCtx.state === 'suspended') { try { audioCtx.resume() } catch { /* 忽略 */ } }
  return audioCtx
}

function drainAudioQueue() {
  if (!audioCtx || audioPlaying || !audioQueue.length) return
  audioPlaying = true
  while (audioQueue.length) {
    const buffer = audioQueue.shift()
    const source = audioCtx.createBufferSource()
    source.buffer = buffer
    source.connect(audioCtx.destination)
    const now = audioCtx.currentTime
    if (audioNextTime < now + 0.03) audioNextTime = now + 0.03
    source.start(audioNextTime)
    audioNextTime += buffer.duration
    source.onended = () => {
      audioSources.delete(source)
      try { source.disconnect() } catch { /* 忽略 */ }
    }
    audioSources.add(source)
  }
  audioPlaying = false
}

function stopAudio() {
  for (const source of audioSources) {
    try { source.onended = null; source.stop() } catch { /* 忽略 */ }
  }
  audioSources.clear()
  audioQueue = []
  audioPlaying = false
  audioNextTime = 0
}

// WS 二进制帧：uint32 LE 采样率 | uint32 LE 声道数(1..8) | float32 LE PCM 交错
function handleXzAudioFrame(data) {
  const ctx = resumeAudio()
  if (!ctx || data.byteLength < 8) return
  const view = new DataView(data, 0, data.byteLength)
  const rate = view.getUint32(0, true)
  const channels = view.getUint32(4, true)
  if (rate < 1 || channels < 1 || channels > 8) return
  const frameBytes = rate * 4
  if (8 + frameBytes * channels > data.byteLength) return
  const buffer = ctx.createBuffer(channels, rate, 48000)
  for (let ch = 0; ch < channels; ch++) {
    buffer.copyToChannel(new Float32Array(data, 8 + ch * frameBytes, rate), ch)
  }
  audioQueue.push(buffer)
  drainAudioQueue()
}

function sendXiaozhiBubble(payload) { desktopBridge.sendXiaozhiBubble?.(payload) }
function sendPetEvent(payload) { desktopBridge.sendPetEvent?.(payload) }

function handleXzTextMessage(raw) {
  let message
  try { message = JSON.parse(raw) } catch { return }
  switch (message.type) {
    case 'sysmsg':
      // 不 push 文本：由历史轮询渲染，避免双通道重复
      break
    case 'hello':
      xzConnected.value = true
      xzSessionId = message.session_id || ''
      xzReconnectDelay = 3000
      sendXiaozhiBubble({ type: 'stop' })
      break
    case 'llm':
      xzThinking.value = true
      if (message.emotion) sendPetEvent({ type: 'emotion', emotion: message.emotion })
      break
    case 'tts':
      if (message.state === 'start') {
        stopAudio()
        sendPetEvent({ type: 'speaking', speaking: true })
      } else if (message.state === 'sentence_start' && message.text) {
        xzThinking.value = false
        sendXiaozhiBubble({ type: 'text', text: message.text })
        sendPetEvent({ type: 'speaking', speaking: true })
      } else if (message.state === 'stop') {
        sendXiaozhiBubble({ type: 'stop' })
        sendXiaozhiBubble({ type: 'speak_stop' })
        sendPetEvent({ type: 'speaking', speaking: false })
        xzThinking.value = false
      }
      break
    case 'pet_text':
      xzThinking.value = false
      xzMessages.value.push({ role: 'assistant', text: message.text, id: null })
      if (followChat.value) nextTick(scrollToBottom)
      break
    case 'error':
      xzConnected.value = false
      xzThinking.value = false
      break
    default:
      break
  }
}

// 重建去重集合后重连
function connectXiaozhi() {
  seenIds = new Set()
  seenFp = new Set()
  for (const message of xzMessages.value) {
    if (message.id) seenIds.add(message.id)
    seenFp.add(`u|${(message.text || '').slice(0, 80)}`)
  }
  loadXzHistory(true)
  connectXzSocket()
}

function loadXzHistory(full) {
  fetch(`/api/xiaozhi/chat-history?limit=${full ? 1000 : 100}`)
    .then((response) => response.json())
    .then((payload) => {
      if (!payload.ok || !payload.history) return
      let added = 0
      for (const item of payload.history) {
        const id = item.id || 0
        const role = item.role === 'user' ? 'user' : item.role === 'system' ? 'system' : 'assistant'
        const text = item.type === 'image'
          ? (item.text && item.text !== ' ' ? `[图片] ${item.text}` : '[图片]')
          : item.text
        const image = item.type === 'image' && item.image_base64
          ? `data:image/jpeg;base64,${item.image_base64}`
          : null
        if (role === 'system' && (text.includes('重连') || text.includes('连接中断'))) continue
        if (id && seenIds.has(id)) continue
        if (role === 'assistant' && xzMessages.value.some((existing) => existing.role === 'assistant'
          && !existing.id && (text.startsWith(existing.text) || existing.text.startsWith(text)))) continue
        if (role === 'user' && item.type !== 'image' && seenFp.has(`u|${text.slice(0, 80)}`)) continue
        xzMessages.value.push({ role, text, image, id })
        if (id) seenIds.add(id)
        if (role === 'user' && item.type !== 'image') seenFp.add(`u|${text.slice(0, 80)}`)
        added += 1
      }
      if (added && followChat.value) nextTick(scrollToBottom)
    })
    .catch(() => { /* 忽略轮询错误 */ })
}

function connectXzSocket() {
  try {
    xzSocket = new WebSocket(`ws://${location.host}/api/xiaozhi/ws?role=chat`)
  } catch {
    scheduleXzReconnect()
    return
  }
  xzSocket.binaryType = 'arraybuffer'
  xzSocket.onopen = () => { /* hello 事件里置连接态 */ }
  xzSocket.onclose = () => { xzConnected.value = false; scheduleXzReconnect() }
  xzSocket.onerror = () => { /* onclose 统一处理 */ }
  xzSocket.onmessage = (event) => {
    if (typeof event.data === 'string') handleXzTextMessage(event.data)
    else handleXzAudioFrame(event.data)
  }
}

function scheduleXzReconnect() {
  window.clearTimeout(xzReconnectTimer)
  xzReconnectTimer = window.setTimeout(connectXiaozhi, xzReconnectDelay)
  xzReconnectDelay = Math.min(15000, Math.round(xzReconnectDelay * 1.6))
}

function sendXzMessage() {
  const text = xzDraft.value.trim()
  if (!text) return
  if (!xzSocket || xzSocket.readyState !== 1) {
    xzMessages.value.push({ role: 'assistant', text: '⚠ 连接中，请稍后再试' })
    return
  }
  resumeAudio()
  stopAudio()
  xzDraft.value = ''
  xzMessages.value.push({ role: 'user', text })
  seenFp.add(`u|${text.slice(0, 80)}`)
  xzThinking.value = true
  if (followChat.value) nextTick(scrollToBottom)
  xzSocket.send(JSON.stringify({ session_id: xzSessionId, type: 'abort', reason: 'user_interrupt' }))
  sendXiaozhiBubble({ type: 'thinking', text: '' })
  xzSocket.send(JSON.stringify({ session_id: xzSessionId, type: 'listen', state: 'detect', text, source: 'text' }))
}

function handleXzComposerKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    sendXzMessage()
    event.preventDefault()
  }
}

onMounted(() => {
  connectXiaozhi()
  window.setInterval(() => loadXzHistory(false), 3000)
})

onUnmounted(() => {
  window.clearTimeout(xzReconnectTimer)
  if (xzSocket) { try { xzSocket.close() } catch { /* 忽略 */ } }
  stopAudio()
})
</script>

<template>
  <div :class="['chat-layout', 'integrated-chat-layout', `chat-display-${context.displayMode}`, { 'conversation-drawer-pinned': conversationDrawerPinned, 'has-custom-background': Boolean(context.chatBackgroundStyle?.['--chat-background-image']) }]" :style="context.chatBackgroundStyle || {}">
    <button
      v-if="conversationDrawerOpen && !conversationDrawerPinned"
      class="conversation-drawer-backdrop"
      type="button"
      aria-label="关闭对话窗口"
      @click="conversationDrawerOpen = false"
    />
    <aside v-if="conversationDrawerOpen || conversationDrawerPinned" class="conversation-drawer">
      <header>
        <div><MessageSquareText :size="17" /><strong>{{ context.isAgentWorkspace ? 'Agent 对话' : '对话窗口' }}</strong><span>{{ context.conversations.length }}</span></div>
        <button type="button" :class="{ active: conversationDrawerPinned }" :title="conversationDrawerPinned ? '取消固定' : '固定抽屉'" @click="toggleConversationDrawerPin"><Pin :size="14" /></button>
      </header>
      <button class="conversation-new-button" type="button" @click="context.createNewConversation"><Plus :size="15" />新对话</button>
      <div class="conversation-drawer-list">
        <article v-for="conversation in context.conversations" :key="conversation.id" :class="{ active: context.selectedConversationId === conversation.id }">
          <button type="button" @click="openConversation(conversation.id)">
            <span><strong>{{ conversation.title }}</strong><small>{{ conversation.preview || (conversation.kind === 'qq' ? '与 QQ 共享上下文' : conversation.kind === 'pet' ? '桌宠独立对话' : '还没有消息') }}</small></span>
            <time>{{ context.formatSidebarTime(conversation.updated_at) }}</time>
          </button>
          <div v-if="['desktop', 'agent', 'qq'].includes(conversation.kind)" class="conversation-drawer-actions">
            <template v-if="conversation.kind === 'desktop' || conversation.kind === 'agent'">
              <button type="button" title="重命名" @click="context.renameConversation(conversation)"><SquarePen :size="13" /></button>
              <button type="button" title="删除" @click="context.deleteConversation(conversation)"><Trash2 :size="13" /></button>
            </template>
            <button v-else type="button" title="选择要清理的 QQ 消息" :disabled="context.sending" @click="beginQqCleanup(conversation)"><ListChecks :size="13" /></button>
          </div>
        </article>
      </div>
    </aside>

    <section
      :class="['chat-column', { 'file-drag-active': context.isFileDragging }]"
      @dragenter="context.handleFileDragEnter"
      @dragover="context.handleFileDragOver"
      @dragleave="context.handleFileDragLeave"
      @drop="context.handleFileDrop"
    >
      <div v-if="!context.isAgentWorkspace && context.latestTaskHandoff?.task_id" class="chat-handoff-notice" role="status">
        <span><ListChecks :size="15" /><strong>已交给 Agent 继续处理</strong><small>详细执行过程在 Agent 页面查看</small></span>
        <button type="button" @click="context.openAgentHandoff">查看任务</button>
      </div>
      <div v-if="context.isFileDragging" class="file-drop-overlay"><Upload :size="25" /><strong>松开即可添加到对话</strong><span>图片、PDF、Word 和其他文件都可以</span></div>

      <div :ref="(element) => { context.chatScroll = element }" class="message-scroll">
        <div v-if="xzMessages.length" class="message-list">
          <article v-for="(turn, index) in xzMessages" :key="`xz-${index}`" :class="['message-row', turn.role]">
            <img v-if="turn.role === 'assistant'" class="message-avatar assistant-avatar" :src="context.avatarUrl" :alt="context.mioDisplayName" />
            <div v-if="turn.role === 'system'" class="sys-msg">{{ turn.text }}</div>
            <div v-else class="message-body">
              <div class="message-heading"><strong>{{ turn.role === 'assistant' ? context.mioDisplayName : '你' }}</strong></div>
              <div class="message-part">
                <div v-if="turn.image" class="message-bubble">
                  <div>
                    <img :src="turn.image" :style="{ maxWidth: '240px', maxHeight: '160px', borderRadius: '8px', display: 'block', marginBottom: '6px' }" />
                    <div v-if="turn.text && turn.text !== '[图片]'">{{ turn.text.replace(/^\[图片\]\s*/, '') }}</div>
                  </div>
                </div>
                <div v-else class="message-bubble">{{ turn.text }}</div>
              </div>
            </div>
            <span v-if="turn.role === 'user'" class="message-avatar user-avatar" aria-label="你"><UserRound :size="18" /></span>
          </article>
          <article v-if="xzThinking" class="message-row assistant pending-message"><img class="message-avatar assistant-avatar" :src="context.avatarUrl" :alt="context.mioDisplayName" /><div class="message-body"><div class="message-heading"><strong>{{ context.mioDisplayName }}</strong><span>正在思考</span></div><div class="thinking-indicator"><i /><i /><i /></div></div></article>
        </div>
        <div v-else class="empty-chat"><h2>我在这里</h2><p>现在想说什么？</p></div>
      </div>

      <div v-if="qqCleanupMode" class="qq-message-cleanup-bar">
        <span>{{ selectedQqMessageIds.length ? `已选择 ${selectedQqMessageIds.length} 句` : '选择要清理的消息' }}</span>
        <button type="button" @click="cancelQqCleanup">取消</button>
        <button type="button" class="danger" :disabled="!selectedQqMessageIds.length" @click="deleteSelectedQqMessages"><Trash2 :size="14" />清理</button>
      </div>
      <div v-else class="composer-wrap">
        <AgentTasksPage v-if="context.isAgentWorkspace" :key="context.selectedConversationId" compact :conversation-id="context.selectedConversationId" />
        <div class="composer">
          <div v-if="context.attachments.length" class="attachment-preview-list">
            <div v-for="attachment in context.attachments" :key="attachment.id" class="attachment-preview">
              <img v-if="attachment.kind === 'image'" :src="attachment.preview_url" :alt="attachment.name" /><FileText v-else :size="19" />
              <span><strong>{{ attachment.name }}</strong><small>{{ context.formatFileSize(attachment.size) }}</small></span><button type="button" title="移除附件" @click="context.removeAttachment(attachment.id)"><X :size="14" /></button>
            </div>
          </div>
          <p v-if="context.attachments.some((item) => item.kind === 'image') && !context.activeModelSupportsVision" class="vision-warning">当前模型不支持识图，图片会保存在本地，但{{ context.mioDisplayName }}无法读取内容</p>
          <textarea v-model="xzDraft" class="composer-input" rows="1" placeholder="和小智聊点什么..." @keydown="handleXzComposerKeydown" />
          <!-- 输入区精简（用户裁决）：只保留「小智连接状态（靠左）」+「发送」。
               原「添加图片或文件 / 上下文用量环 / 模型下拉 / 模型与API设置」四个控件已移除；
               图片上传改由小智插件的 📷 按钮承担（dist/plugins/xiaozhi/chat-inject.js），
               模型与API设置在侧栏「设置」内。附件仍可拖拽文件到对话区添加。 -->
          <div class="composer-actions">
            <input :ref="(element) => { context.fileInput = element }" class="file-input" type="file" multiple @change="context.handleFileSelection" />
            <span v-if="context.isAgentWorkspace" class="agent-tool-mode" title="澪会按任务选择已接入的工具；文件访问遵循你的授权范围"><Wrench :size="14" />工具自动调用</span>
            <span :class="['xz-link-status', { connected: xzConnected }]">{{ xzConnected ? '小智已连接' : '小智连接中…' }}</span>
            <span class="composer-flex-spacer" />
            <button type="button" class="send-button" :disabled="!xzDraft.trim()" @click="sendXzMessage"><Send :size="17" /></button>
          </div>
        </div>
      </div>
    </section>
  </div>

  <ImagePreview v-if="activeImageAttachment" :key="activeImageAttachment.url" :attachment="activeImageAttachment" @close="closeImagePreview" />
</template>
