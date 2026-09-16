import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

/**
 * Revive Lab lives at app.cyrix.in/revive, behind the portal's rewrite.
 *
 * The same arrangement as KPI at /kpi: Vite writes /revive/ into
 * index.html, React Router strips it from every route, and the build goes
 * into dist/revive so the files sit where the page will look for them.
 *
 * No service worker. KPI has one because it installs as an app on phones;
 * this module has no offline story, and a worker is the one thing on a
 * shared origin that can outlive a deploy and serve the wrong files.
 */
export default defineConfig({
  base: '/revive/',
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    outDir: 'dist/revive',
    emptyOutDir: true,
  },
  server: { port: 5177 },
  test: {
    environment: 'node',
  },
} as never)
