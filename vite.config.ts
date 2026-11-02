import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 상대 경로 빌드: dist/를 어느 경로에 두어도(로컬 정적 서버) 동작
  base: './',
  worker: { format: 'es' },
})
