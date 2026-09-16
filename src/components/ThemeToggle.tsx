import { useEffect, useState } from 'react'
import { flushSync } from 'react-dom'
import { Sun, Moon } from 'lucide-react'
import {
  type Theme, readTheme, setTheme, nextTheme, resolveTheme, THEME_KEY,
} from '@/lib/theme'

/**
 * Light or dark, shared by every Cyrix module.
 *
 * The same switch Spare has: two states, one icon showing at a time, the
 * outgoing one rotating and shrinking away as the incoming one arrives.
 * Both live in the same grid cell, absolutely placed, which is what stops
 * the button flinching by a pixel as they exchange.
 *
 * Someone who has never pressed it follows their device — "system" is the
 * stored default. Pressing it is an explicit choice from then on, and that
 * choice is written to one key that all four modules read, so it holds
 * when you click through to another tile.
 */
export default function ThemeToggle({ className = '' }: { className?: string }) {
  const [theme, setLocal] = useState<Theme>(() => readTheme())

  // Another module, in another tab, on the same origin. Its choice arrives
  // here as a storage event.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_KEY) setLocal(readTheme())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  /**
   * Switches as a circular reveal spreading from the button, using the
   * View Transitions API: the browser holds a snapshot of the old theme
   * while the new one is clipped in over it, so every colour crosses
   * together instead of several hundred elements each easing their own.
   * Without the API, or with reduced motion asked for, it simply changes.
   */
  function toggle(event: React.MouseEvent<HTMLButtonElement>) {
    const next = nextTheme(theme)
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const start = (document as Document & {
      startViewTransition?: (cb: () => void) => void
    }).startViewTransition

    const commit = () => { setTheme(next); setLocal(next) }

    if (reduced || typeof start !== 'function') {
      commit()
      return
    }

    const x = event.clientX
    const y = event.clientY
    // The distance to the furthest corner, so the circle always finishes
    // covering the screen whichever corner the button sits in.
    const radius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y),
    )
    const root = document.documentElement
    root.style.setProperty('--theme-x', `${x}px`)
    root.style.setProperty('--theme-y', `${y}px`)
    root.style.setProperty('--theme-r', `${radius}px`)

    // flushSync is required: startViewTransition snapshots the DOM when
    // its callback returns, and a normal React update would not have
    // landed by then — it would snapshot the old theme twice.
    start.call(document, () => { flushSync(commit) })
  }

  const dark = resolveTheme(theme) === 'dark'

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      className={`btn-press relative grid h-9 w-9 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-ink-100 hover:text-ink-700 ${className}`}
    >
      <Sun
        className={`absolute h-5 w-5 text-amber-500 transition-all duration-[var(--dur-ui)] ${
          dark ? 'rotate-0 scale-100 opacity-100' : 'rotate-90 scale-50 opacity-0'
        }`}
      />
      <Moon
        className={`absolute h-5 w-5 text-indigo-400 transition-all duration-[var(--dur-ui)] ${
          dark ? '-rotate-90 scale-50 opacity-0' : 'rotate-0 scale-100 opacity-100'
        }`}
      />
    </button>
  )
}
