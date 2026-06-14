import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: true,
    proxy: {
      // In dev the Vite server proxies API calls to the Node API server.
      '/api': {
        target: 'http://127.0.0.1:3089',
        changeOrigin: true,
      },
    },
  },
  preview: {
    allowedHosts: true,
  },
})