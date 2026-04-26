import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Lokale Fonts (statt Google Fonts CDN — Tauri-WebView rendert dann identisch zum Browser)
import '@fontsource/inter/300.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/playfair-display/400.css'
import '@fontsource/playfair-display/500.css'
import '@fontsource/playfair-display/600.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@/styles/globals.css'
import App from './App.tsx'

// Auto-Update Test: minor change to trigger new release v0.1.2
console.log('LATAIF starting…');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
