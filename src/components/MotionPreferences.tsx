import { MotionConfig, type Transition } from 'framer-motion'
import type { ReactNode } from 'react'
import { useMediaQuery } from '../hooks/useMediaQuery'
import { useStore } from '../store/useStore'

// A short, non-bouncy response: controls should settle before the next action.
const QUICK_TRANSITION: Transition = { duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }
const INSTANT_TRANSITION: Transition = { duration: 0 }

export function MotionPreferences({ children }: { children: ReactNode }) {
  const preference = useStore((s) => s.settings.reducedMotion)
  const systemPreference = useMediaQuery('(prefers-reduced-motion: reduce)')
  const reduced = preference || systemPreference

  return (
    <MotionConfig
      reducedMotion={reduced ? 'always' : 'never'}
      transition={reduced ? INSTANT_TRANSITION : QUICK_TRANSITION}
    >
      {children}
    </MotionConfig>
  )
}
