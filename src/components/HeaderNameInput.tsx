import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type InputHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '../lib/cn'
import { filterHeaderSuggestions } from '../lib/commonHeaders'

type NativeProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'role'>

interface Props extends NativeProps {
  value: string
  onChange: (value: string) => void
  /** Called after a suggestion was picked (e.g. to move focus to the value). */
  onPick?: (name: string) => void
  suggestions?: readonly string[]
}

interface Placement {
  left: number
  width: number
  top?: number
  bottom?: number
  maxHeight: number
}

const MAX_LIST_HEIGHT = 232
const GAP = 4

/**
 * Text input with a filtered drop-down of common request header names.
 * The list is portalled to <body> so the modal's scroll/overflow containers
 * can't clip it, and it only renders when something actually matches.
 */
export function HeaderNameInput({ value, onChange, onPick, suggestions, className, onFocus, onBlur, onKeyDown, ...rest }: Props) {
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [placement, setPlacement] = useState<Placement | null>(null)

  const matches = useMemo(() => {
    const list = filterHeaderSuggestions(value, suggestions)
    // A lone suggestion identical to what's typed adds nothing.
    if (list.length === 1 && list[0]!.toLowerCase() === value.trim().toLowerCase()) return []
    return list
  }, [value, suggestions])

  const visible = open && matches.length > 0

  // Keep the highlighted row valid as the list shrinks/grows.
  useEffect(() => {
    setActive((i) => (i >= matches.length ? matches.length - 1 : i))
  }, [matches.length])

  const place = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const below = window.innerHeight - r.bottom - GAP - 8
    const above = r.top - GAP - 8
    if (below >= Math.min(MAX_LIST_HEIGHT, 140) || below >= above) {
      setPlacement({ left: r.left, width: r.width, top: r.bottom + GAP, maxHeight: Math.max(80, Math.min(MAX_LIST_HEIGHT, below)) })
    } else {
      setPlacement({ left: r.left, width: r.width, bottom: window.innerHeight - r.top + GAP, maxHeight: Math.max(80, Math.min(MAX_LIST_HEIGHT, above)) })
    }
  }, [])

  useLayoutEffect(() => {
    if (!visible) return
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    // The dialog animates in/expands; follow the input while it moves.
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null
    if (observer && inputRef.current) observer.observe(inputRef.current)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      observer?.disconnect()
    }
  }, [visible, place])

  // Keep the highlighted option scrolled into view.
  useEffect(() => {
    if (!visible || active < 0) return
    const node = listRef.current?.children[active] as HTMLElement | undefined
    node?.scrollIntoView?.({ block: 'nearest' })
  }, [active, visible])

  const pick = (name: string) => {
    onChange(name)
    setOpen(false)
    setActive(-1)
    onPick?.(name)
  }

  return (
    <>
      <input
        {...rest}
        ref={inputRef}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={visible ? listId : undefined}
        aria-activedescendant={visible && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        className={className}
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={(e) => {
          setOpen(true)
          onFocus?.(e)
        }}
        onBlur={(e) => {
          setOpen(false)
          setActive(-1)
          onBlur?.(e)
        }}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            if (!open) setOpen(true)
            else if (matches.length) setActive((i) => (i + 1) % matches.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            if (!open) setOpen(true)
            else if (matches.length) setActive((i) => (i <= 0 ? matches.length - 1 : i - 1))
          } else if (e.key === 'Enter' && visible && active >= 0) {
            // Pick the suggestion instead of submitting the form.
            e.preventDefault()
            pick(matches[active]!)
          } else if (e.key === 'Tab' && visible && active >= 0) {
            pick(matches[active]!)
          } else if (e.key === 'Escape' && visible) {
            // Close just the list, not the whole dialog.
            e.preventDefault()
            e.stopPropagation()
            setOpen(false)
            setActive(-1)
          }
          onKeyDown?.(e)
        }}
      />
      {visible && placement && typeof document !== 'undefined' &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Common headers"
            className="header-suggest glass-scroll fixed z-[70] overflow-y-auto rounded-xl border p-1 text-[12px] shadow-2xl"
            style={{ left: placement.left, width: placement.width, top: placement.top, bottom: placement.bottom, maxHeight: placement.maxHeight }}
            // Keep focus in the input while clicking an option.
            onMouseDown={(e) => e.preventDefault()}
          >
            {matches.map((name, i) => (
              <li
                key={name}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(name)}
                className={cn(
                  'cursor-pointer truncate rounded-lg px-2.5 py-1.5 font-mono',
                  i === active ? 'bg-[var(--brand-soft)] text-[var(--fg)]' : 'text-[var(--muted)]',
                )}
              >
                <Highlight text={name} query={value.trim()} />
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  )
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>
  const at = text.toLowerCase().indexOf(query.toLowerCase())
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-transparent font-semibold text-[var(--fg)]">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  )
}
