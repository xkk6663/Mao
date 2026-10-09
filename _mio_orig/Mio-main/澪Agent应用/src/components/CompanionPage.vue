<script setup>
import { inject, onMounted, ref } from 'vue'
import PetAppearancePanel from './PetAppearancePanel.vue'
import { Activity, Box, Check, Gamepad2, Monitor, Play, Power, RefreshCw, RotateCw, Sparkles, Volume2, Wifi } from '@lucide/vue'

const context = inject('mio-companion-page')
if (!context) throw new Error('桌宠页上下文未初始化')

// ---- 模型管理 + 体检（我方接口直连）----
const models = ref([])
const currentModelId = ref('')
const sched = ref({ enabled: false, time: '09:00', mode: 'random', last_switched: '' })
const modelMsg = ref('')
const observe = ref({ enabled: false, range: '5-15' })
const observeMsg = ref('')
const health = ref({ devices: [], defaultName: '', version: {}, xiaozhi: {}, audioBanner: '' })
const healthMsg = ref('')

// ---- 小智状态栏（右侧）----
const xz = ref({ connected: false, session_id: '', vision: false, vision_url: '', observe_enabled: false, observe_next: 0 })
const xzMsg = ref('')

async function loadXzStatus() {
  try {
    const [st, vi, ob] = await Promise.all([
      apiGet('/api/xiaozhi/status').catch(() => ({ connected: false })),
      apiGet('/api/xiaozhi/vision-info').catch(() => ({ ok: false })),
      apiGet('/api/xiaozhi/observe/status').catch(() => ({ enabled: false, next_in_seconds: 0 })),
    ])
    xz.value = {
      connected: Boolean(st.connected),
      session_id: st.session_id || '',
      vision: Boolean(vi.ok),
      vision_url: vi.url || '',
      observe_enabled: Boolean(ob.enabled),
      observe_next: Number(ob.next_in_seconds || 0),
    }
    xzMsg.value = ''
  } catch (e) { xzMsg.value = '读取失败：' + e.message }
}

async function apiGet(url) {
  const r = await fetch(url, { cache: 'no-store' })
  if (!r.ok) throw new Error(url + ' -> ' + r.status)
  return r.json()
}
async function apiSend(url, method, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  if (!r.ok) {
    let msg = 'HTTP ' + r.status
    try { const j = await r.json(); msg = j.detail || msg } catch (e) {}
    throw new Error(msg)
  }
  return r.json()
}

async function loadModels() {
  try {
    const [m, s] = await Promise.all([apiGet('/api/companion/live2d/models'), apiGet('/api/companion/live2d/schedule')])
    models.value = (m.models || []).map((md) => ({ id: md.id, name: md.display_name || md.name || md.id }))
    sched.value = s || sched.value
    try {
      const st = await apiGet('/api/companion/status')
      currentModelId.value = ((st.live2d && st.live2d.runtime) || {}).model_id || ''
    } catch (e) {}
  } catch (e) { modelMsg.value = '读取模型失败：' + e.message }
}

async function switchModel(modelId) {
  modelMsg.value = '正在切换…'
  try {
    await apiSend('/api/companion/settings', 'PATCH', { live2d_model_id: modelId })
    modelMsg.value = '✓ 已切换，桌宠正在换装'
    setTimeout(loadModels, 2500)
  } catch (e) { modelMsg.value = '✗ 切换失败：' + e.message }
}

async function saveSchedule() {
  try {
    await apiSend('/api/companion/live2d/schedule', 'PATCH', {
      enabled: sched.value.enabled,
      time: sched.value.time || '09:00',
      mode: sched.value.mode,
    })
    modelMsg.value = sched.value.enabled ? '✓ 已保存（每天 ' + sched.value.time + ' 自动换）' : '✓ 已关闭自动更换'
    setTimeout(loadModels, 1200)
  } catch (e) { modelMsg.value = '✗ 保存失败：' + e.message }
}

async function loadHealth() {
  try {
    const [dev, ver, xz] = await Promise.all([
      apiGet('/api/companion/audio/devices'),
      apiGet('/api/companion/version').catch(() => ({ data: {} })),
      apiGet('/api/xiaozhi/status').catch(() => ({})),
    ])
    const defaultName = dev.default ? dev.default.name : ''
    let banner = ''
    const def = (dev.devices || []).find((d) => d.is_default)
    if (!def) banner = '⚠ 未识别到默认输出设备'
    else if (def.muted) banner = '⚠ 默认设备「' + def.name + '」已静音'
    else if (def.volume != null && def.volume < 30) banner = '⚠ 默认设备音量仅 ' + def.volume + '%，建议调大'
    else banner = '✓ 默认设备正常（' + (def.volume != null ? def.volume + '%' : '?') + '）'
    health.value = { devices: dev.devices || [], defaultName, version: (ver && ver.data) || {}, xiaozhi: xz || {}, audioBanner: banner }
  } catch (e) { healthMsg.value = '体检读取失败：' + e.message }
}

async function playSystemTone() {
  try {
    await apiSend('/api/companion/audio/test', 'POST', { freq: 440, seconds: 1.2 })
    healthMsg.value = '已播放系统测试音'
  } catch (e) { healthMsg.value = '播放失败：' + e.message }
}
async function playWebTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const osc = ctx.createOscillator(); osc.frequency.value = 880
    const g = ctx.createGain(); g.gain.value = 0.4
    osc.connect(g); g.connect(ctx.destination)
    osc.start()
    setTimeout(() => { try { osc.stop() } catch (e) {} }, 1500)
    healthMsg.value = '已播放网页测试音'
  } catch (e) { healthMsg.value = '播放失败：' + e.message }
}

// ---- 屏幕自动观察 ----
async function saveObserve() {
  try {
    const rangeMap = { '5-15': [300, 900], '10-30': [600, 1800], '30-60': [1800, 3600] }
    const [lo, hi] = rangeMap[observe.value.range] || [300, 900]
    const url = observe.value.enabled ? '/api/xiaozhi/observe/start' : '/api/xiaozhi/observe/stop'
    await apiSend(url, 'POST', { enabled: observe.value.enabled, min_seconds: lo, max_seconds: hi, quiet_start: '23:00', quiet_end: '08:00' })
    observeMsg.value = observe.value.enabled ? '✓ 自动观察已开启（' + observe.value.range + ' 分钟随机）' : '✓ 自动观察已关闭'
  } catch (e) { observeMsg.value = '✗ 保存失败：' + e.message }
}

async function triggerObserveNow() {
  observeMsg.value = '截屏分析中…'
  try {
    const shot = await apiSend('/api/companion/screen-shot', 'POST', {})
    if (!shot.ok) throw new Error('截图失败')
    const vision = await apiSend('/api/xiaozhi/vision', 'POST', {
      image_base64: shot.image_base64,
      question: '用调侃吐槽的语气，简短评价我屏幕上正在做的事。',
    })
    if (!vision.ok) throw new Error(vision.detail || '小智视觉失败')
    const say = await apiSend('/api/xiaozhi/say', 'POST', { text: '你看看我的屏幕：' + (vision.text || '') })
    observeMsg.value = say.ok ? '✓ 已让小智评价：' + String(vision.text || '').slice(0, 60) + '…' : '注入失败'
  } catch (e) { observeMsg.value = '✗ ' + e.message }
}

function openScreenCrop() {
  if (window.mioDesktop && typeof window.mioDesktop.openScreenCrop === 'function') window.mioDesktop.openScreenCrop()
  else if (window.pywebview?.api?.open_screen_crop) window.pywebview.api.open_screen_crop()
  else observeMsg.value = '快捷键可用：任意软件按 Ctrl+Shift+S 框选区域'
}

onMounted(() => { loadModels(); loadHealth(); loadXzStatus() })
</script>

<template>
  <section class="companion-hub">
    <div class="companion-main">
    <nav class="companion-tab-bar compact-companion-tabs" aria-label="桌宠功能">
      <button type="button" :class="{ active: context.activeCompanionSection === 'pet-panel' }" @click="context.activeCompanionSection = 'pet-panel'"><Gamepad2 :size="16" />桌宠</button>
      <button type="button" :class="{ active: context.activeCompanionSection === 'voice-panel' }" @click="context.activeCompanionSection = 'voice-panel'"><Volume2 :size="16" />语音</button>
      <button type="button" :class="{ active: context.activeCompanionSection === 'screen-panel' }" @click="context.activeCompanionSection = 'screen-panel'"><Monitor :size="16" />观察</button>
      <button type="button" :class="{ active: context.activeCompanionSection === 'model-panel' }" @click="context.activeCompanionSection = 'model-panel'"><Box :size="16" />模型</button>
      <button type="button" :class="{ active: context.activeCompanionSection === 'health-panel' }" @click="context.activeCompanionSection = 'health-panel'"><Activity :size="16" />体检</button>
    </nav>

    <PetAppearancePanel
      v-if="context.activeCompanionSection === 'pet-panel'"
      :status="context.companionStatus"
      :avatar-url="context.companionAvatarUrl"
      :display-name="context.mioDisplayName"
      :busy="Boolean(context.companionBusy)"
      control-mode
      @control="context.controlCompanion"
      @save="context.saveCompanionSettings('pet')"
      @save-size="context.saveCompanionSize"
      @manage="context.openSettingsSection('pet')"
    />

    <section v-else-if="context.activeCompanionSection === 'voice-panel'" class="companion-simple-panel voice-simple-panel">
      <header><div><Volume2 :size="19" /><span><h2>{{ context.mioDisplayName }}的语音</h2><p>运行、播放与常用朗读方式</p></span></div><span :class="['connection-label', { online: context.companionStatus.voice_runtime.service_running }]">{{ context.companionStatus.voice_runtime.service_running ? '在线' : '未启动' }}</span></header>
      <div class="voice-quick-grid">
        <label><span><strong>回复时朗读</strong><small>使用{{ context.mioDisplayName }}的专属音色</small></span><span class="switch-control"><input v-model="context.companionStatus.pet.settings.voice_enabled" type="checkbox" /><i /></span></label>
        <label><span><strong>主动消息朗读</strong><small>桌宠主动开口时播放</small></span><span class="switch-control"><input v-model="context.companionStatus.pet.settings.speak_proactive" type="checkbox" /><i /></span></label>
        <label><span><strong>观察回应朗读</strong><small>屏幕观察产生回应时播放</small></span><span class="switch-control"><input v-model="context.companionStatus.pet.settings.speak_screen_observations" type="checkbox" /><i /></span></label>
        <label><span><strong>流式播放</strong><small>生成一段，播放一段</small></span><span class="switch-control"><input v-model="context.companionStatus.pet.settings.voice_streaming_enabled" type="checkbox" /><i /></span></label>
      </div>
      <div class="voice-quick-settings"><label><span>音量</span><input v-model.number="context.companionStatus.pet.settings.voice_volume" type="range" min="0" max="100" :style="context.rangeInputStyle(context.companionStatus.pet.settings.voice_volume, 0, 100)" /><b>{{ context.companionStatus.pet.settings.voice_volume }}%</b></label></div>
      <div class="voice-runtime-summary"><div><strong>{{ context.mioDisplayName }}专属音色</strong><span>{{ context.companionStatus.voice_runtime.emotion_reference_ready ? `${context.companionStatus.voice_runtime.emotion_reference_count} 种情绪参考已就绪` : '情绪参考库未就绪' }}</span></div><p v-if="context.companionStatus.voice_runtime.last_error">{{ context.companionStatus.voice_runtime.last_error }}</p></div>
      <footer class="companion-action-bar"><button type="button" :disabled="Boolean(context.companionBusy)" @click="context.controlVoiceRuntime('start')"><Play :size="15" />启动</button><button type="button" :disabled="Boolean(context.companionBusy)" @click="context.controlVoiceRuntime('stop')"><Power :size="15" />停止</button><button type="button" :disabled="Boolean(context.companionBusy)" @click="context.controlVoiceRuntime('restart')"><RotateCw :size="15" />重启</button><button type="button" :disabled="Boolean(context.companionBusy)" @click="context.testCompanionVoice"><Volume2 :size="15" />试听</button><button class="primary-button" type="button" :disabled="Boolean(context.companionBusy)" @click="context.saveCompanionSettings('voice')"><Check :size="15" />应用修改</button></footer>
    </section>

    <section v-else-if="context.activeCompanionSection === 'screen-panel'" class="companion-simple-panel observer-simple-panel">
      <header><div><Monitor :size="19" /><span><h2>屏幕自动观察（冷不丁评价）</h2><p>随机截屏让小智评价你的屏幕</p></span></div><span class="connection-label" :class="{ online: xz.observe_enabled }">{{ xz.observe_enabled ? '观察中' : '未启动' }}</span></header>
      <div class="observe-auto-block">
        <div class="voice-quick-grid">
          <label><span><strong>自动观察</strong><small>随机截屏让小智评价你的屏幕</small></span><span class="switch-control"><input v-model="observe.enabled" type="checkbox" @change="saveObserve" /><i /></span></label>
          <label><span><strong>快捷键</strong><small>全局 Ctrl+Shift+S 框选区域投喂</small></span><b class="shortcut-chip">Ctrl+Shift+S</b></label>
        </div>
        <div class="voice-quick-settings">
          <label><span>间隔(分)</span><select v-model="observe.range"><option value="5-15">5–15 分钟随机</option><option value="10-30">10–30 分钟随机</option><option value="30-60">30–60 分钟随机</option></select></label>
          <label><span>免打扰</span><span class="dim-text">23:00 – 08:00</span></label>
        </div>
        <div class="voice-runtime-summary"><strong>上次更换：{{ sched.last_switched || '尚未更换' }}</strong></div>
        <footer class="companion-action-bar">
          <button type="button" @click="triggerObserveNow"><Sparkles :size="15" />立即观察一次</button>
          <button type="button" @click="openScreenCrop"><Monitor :size="15" />框选屏幕区域</button>
        </footer>
        <p class="companion-panel-msg">{{ observeMsg }}</p>
      </div>
    </section>

    <section v-else-if="context.activeCompanionSection === 'model-panel'" class="companion-simple-panel model-simple-panel">
      <header><div><Box :size="19" /><span><h2>Live2D 模型管理</h2><p>切换模型、导入与每天定时自动更换</p></span></div><button type="button" title="刷新" @click="loadModels"><RefreshCw :size="15" /></button></header>
      <div class="model-list">
        <div v-for="md in models" :key="md.id" class="model-item">
          <span class="model-name">{{ md.name }}</span>
          <span class="model-id">{{ md.id }}</span>
          <span v-if="String(md.id) === String(currentModelId)" class="model-cur">当前</span>
          <button v-else type="button" class="model-switch" @click="switchModel(md.id)">切换</button>
        </div>
        <div v-if="!models.length" class="model-empty">暂无模型</div>
      </div>
      <div class="voice-quick-settings">
        <label><span>自动更换</span><span class="switch-control"><input v-model="sched.enabled" type="checkbox" @change="saveSchedule" /><i /></span></label>
        <label><span>时间</span><input v-model="sched.time" type="time" @change="saveSchedule" /></label>
        <label><span>模式</span><select v-model="sched.mode" @change="saveSchedule"><option value="random">随机</option><option value="sequential">顺序</option></select></label>
      </div>
      <div class="voice-runtime-summary"><strong>上次更换：{{ sched.last_switched || '尚未更换' }}</strong></div>
      <p class="companion-panel-msg">{{ modelMsg }}</p>
    </section>

    <section v-else class="companion-simple-panel health-simple-panel">
      <header><div><Activity :size="19" /><span><h2>桌宠体检</h2><p>音频输出、小智连接与应用版本</p></span></div><button type="button" title="刷新" @click="loadHealth"><RefreshCw :size="15" /></button></header>
      <div class="health-banner">{{ health.audioBanner }}</div>
      <div class="voice-quick-grid">
        <div v-for="d in health.devices" :key="d.name" class="health-device">
          <span>{{ d.name }}</span><b v-if="d.is_default" class="health-def">默认</b><b v-if="d.muted" class="health-muted">静音</b>
          <i>{{ d.volume != null ? d.volume + '%' : '?' }}</i>
        </div>
        <div v-if="!health.devices.length" class="model-empty">未发现输出设备</div>
      </div>
      <div class="health-rows">
        <div><span>小智连接</span><b :class="health.xiaozhi.connected ? 'health-ok' : 'health-bad'">{{ health.xiaozhi.connected ? '已连接' : '断开' }}</b></div>
        <div><span>会话 ID</span><b>{{ health.xiaozhi.session_id || '-' }}</b></div>
        <div><span>后端服务</span><b>{{ health.version.name || '-' }}</b></div>
        <div><span>后端 Python</span><b>{{ health.version.python || '-' }}</b></div>
        <div><span>音频解码</span><b>{{ health.version.av || '-' }}</b></div>
      </div>
      <footer class="companion-action-bar">
        <button type="button" @click="playWebTone"><Volume2 :size="15" />网页测试音</button>
        <button type="button" @click="playSystemTone"><Play :size="15" />系统测试音</button>
      </footer>
      <p class="companion-panel-msg">{{ healthMsg }}</p>
    </section>
    </div>

    <aside class="companion-sidebar" aria-label="小智状态">
      <header><div><Wifi :size="17" /><span><h2>小智状态</h2><p>对话、视觉与屏幕观察</p></span></div><button type="button" title="刷新" @click="loadXzStatus"><RefreshCw :size="14" /></button></header>
      <dl class="xz-status-list">
        <div><dt>对话连接</dt><dd :class="xz.connected ? 'health-ok' : 'health-bad'">{{ xz.connected ? '已连接' : '断开' }}</dd></div>
        <div><dt>会话 ID</dt><dd class="xz-session">{{ xz.session_id || '-' }}</dd></div>
        <div><dt>视觉能力</dt><dd :class="xz.vision ? 'health-ok' : 'health-bad'">{{ xz.vision ? '已捕获' : '未捕获' }}</dd></div>
        <div><dt>自动观察</dt><dd :class="xz.observe_enabled ? 'health-ok' : 'health-bad'">{{ xz.observe_enabled ? '开启' : '关闭' }}</dd></div>
        <div v-if="xz.observe_enabled"><dt>下次观察</dt><dd>{{ xz.observe_next > 0 ? xz.observe_next + ' 秒后' : '等待中' }}</dd></div>
      </dl>
      <div v-if="xz.vision && xz.vision_url" class="xz-vision-url" :title="xz.vision_url">视觉端点：{{ xz.vision_url }}</div>
      <p v-if="xzMsg" class="companion-panel-msg">{{ xzMsg }}</p>
    </aside>
  </section>
</template>
