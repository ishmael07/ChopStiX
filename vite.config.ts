import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base so the build works at any path (e.g. GitHub Pages /ChopStiX/).
export default defineConfig({
  base: './',
  plugins: [react()],
})
