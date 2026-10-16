import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'
import './styles/integrated.css'
import './styles/refinements.css'
// 必须最后导入：回仓补回的后置覆盖样式（原规则在 v4.0 构建产物末尾，靠层叠覆盖前面的定义）
import './styles/restored-overrides.css'

createApp(App).mount('#app')
