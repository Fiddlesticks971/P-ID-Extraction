import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves project sites from /<repo>/, so assets need that
  // prefix. Set BASE_PATH at build time to deploy somewhere else (a root
  // domain just needs "/").
  base: process.env.BASE_PATH ?? '/',
})
