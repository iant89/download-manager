import { useEffect, useRef } from 'react'

export interface Hotkey {
  /** Lower-case `event.key`, e.g. 'n', '/', 'escape'. */
  key: string
  mod?: boolean
  shift?: boolean
  /** Ignore keystrokes that originate in an input/textarea/select. */
  allowInInput?: boolean
  /** Extra gate — hotkey is skipped when the predicate returns false. */
  when?: () => boolean
  run: (event: KeyboardEvent) => void
}

const EDITABLE = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export function useHotkeys(hotkeys: Hotkey[]): void {
  const ref = useRef(hotkeys)
  ref.current = hotkeys

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const inEditable =
        target && (EDITABLE.has(target.tagName) || target.isContentEditable === true)

      for (const hotkey of ref.current) {
        if (hotkey.when && !hotkey.when()) continue
        const mod = hotkey.mod ? event.metaKey || event.ctrlKey : !event.metaKey && !event.ctrlKey
        if (!mod) continue
        if (hotkey.shift && !event.shiftKey) continue
        if (event.key.toLowerCase() !== hotkey.key.toLowerCase()) continue
        if (inEditable && !hotkey.allowInInput) continue
        event.preventDefault()
        hotkey.run(event)
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
