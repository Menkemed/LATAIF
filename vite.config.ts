import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFileSync } from 'fs'
import { OCR_BASE, OCR_FILES } from './src/core/ai/ocr-assets'

// OCR ships with the app (src/core/ai/ocr-assets.ts): tesseract's worker, engine core and language
// data are served under /ocr/ in dev and written to dist/ocr/ for the build — no CDN at runtime.
function ocrAssets(): Plugin {
  const names = new Set(Object.keys(OCR_FILES))
  const source = (name: string) => readFileSync(path.resolve(__dirname, OCR_FILES[name]))
  return {
    name: 'lataif-ocr-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url || '').split('?')[0]
        const name = url.startsWith(OCR_BASE) ? url.slice(OCR_BASE.length) : ''
        if (!names.has(name)) return next()
        res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
        res.end(source(name))
      })
    },
    generateBundle() {
      for (const name of names) {
        this.emitFile({ type: 'asset', fileName: OCR_BASE.slice(1) + name, source: source(name) })
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ocrAssets()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: true, // LAN-Zugriff: erreichbar via http://<laptop-ip>:5173
    port: 5173,
    strictPort: false,
  },
})
