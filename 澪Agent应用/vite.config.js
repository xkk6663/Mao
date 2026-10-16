import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

const localBackendProxy = () => ({
  target: 'http://127.0.0.1:8000',
  changeOrigin: false,
  configure(proxy) {
    proxy.on('proxyReq', (proxyRequest, request) => {
      if (request.headers.host) proxyRequest.setHeader('host', request.headers.host)
    })
  },
})

export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    // ⚠ 必须隔离输出：dist/ 里除了 vite 产物（assets/ 与 index.html）之外，
    // 还住着 257 个手写「注入层」文件（core-inject / kernel / plugins / live2d-pet）。
    // vite 默认 outDir 是 'dist' 且构建前会清空它 —— 那样会一次性毁掉整个注入层。
    // 因此构建只写 dist-build/，再由 scripts/compose-dist.mjs 组装回 dist/。
    outDir: 'dist-build',
    emptyOutDir: true,
  },
  server: {
    port: 1420,
    strictPort: false,
    proxy: {
      '/api': localBackendProxy(),
      '/onebot': localBackendProxy(),
      '/diaries': localBackendProxy(),
      '/reviews': localBackendProxy(),
      '/weekly': localBackendProxy(),
      '/stats': localBackendProxy(),
      '/static': localBackendProxy(),
      '/agent-files': localBackendProxy(),
    }
  }
})
