import { useEffect } from 'react'
import { useStore } from '../store/useStore'

/** Applies the theme preference to <html> and follows the OS when asked to. */
export function useTheme(): void {
  const theme = useStore((s) => s.settings.theme)
  const reducedMotion = useStore((s) => s.settings.reducedMotion)

  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      root.classList.toggle('dark', dark)
      root.style.colorScheme = dark ? 'dark' : 'light'
      const meta = document.querySelector('meta[name="theme-color"]')
      if (meta) meta.setAttribute('content', dark ? '#06080f' : '#eef1f8')
    }
    apply()
    if (theme !== 'system') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => {
    document.documentElement.classList.toggle('reduced-motion', reducedMotion)
  }, [reducedMotion])
}
