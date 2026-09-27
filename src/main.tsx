import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installDebugCapture } from './lib/debugLog'
import './index.css'

installDebugCapture()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
