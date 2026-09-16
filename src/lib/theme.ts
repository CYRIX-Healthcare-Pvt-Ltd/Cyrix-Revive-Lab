/**
 * One theme choice, shared by every Cyrix module.
 *
 * All four apps are served from app.cyrix.in, so they share an origin and
 * therefore share localStorage. Choosing dark in KPI and clicking through
 * to Spare should not land you back in light — the modules are meant to
 * read as one product, and nothing gives that away faster than the page
 * changing colour when you move between them.
 *
 * Both mechanisms are applied on every change, deliberately:
 *
 *   data-theme="dark"   KPI and BEMMP select on the attribute
 *   class="dark"        Spare's Tailwind is configured darkMode: 'class'
 *
 * Writing both is a few bytes and means neither app has to be restyled to
 * join in. An app that understands only one simply ignores the other.
 *
 * Three states, not two. "system" is the default and the one most people
 * stay on, and it is genuinely different from light: it follows the phone
 * into dark at sunset. Storing only a boolean would silently strand
 * everybody on whichever the app happened to guess first.
 */
export type Theme = 'light' | 'dark' | 'system'

/** Namespaced, because it is read by four separate applications. */
export const THEME_KEY = 'cyrix.theme'

/**
 * The per-app keys this replaces. Read once so nobody who already chose
 * dark inside Spare or BEMMP is quietly reset by the move to a shared one.
 */
const LEGACY_KEYS = ['cyrix-spare-theme', 'bemmp-theme', 'blue-star-theme']

const isTheme = (v: unknown): v is Theme =>
  v === 'light' || v === 'dark' || v === 'system'

/** What the browser would pick if nobody had chosen. */
export function systemTheme(): 'light' | 'dark' {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light'
}

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (isTheme(stored)) return stored

    for (const key of LEGACY_KEYS) {
      const legacy = localStorage.getItem(key)
      if (isTheme(legacy)) {
        localStorage.setItem(THEME_KEY, legacy)
        return legacy
      }
    }
  } catch {
    // Private windows and blocked site data throw rather than returning
    // null. Following the machine is the right answer when we cannot
    // remember a choice.
  }
  return 'system'
}

/** What "system" actually resolves to right now. */
export function resolveTheme(theme: Theme): 'light' | 'dark' {
  return theme === 'system' ? systemTheme() : theme
}

/**
 * Paint it. Removing the attribute for "system" rather than writing the
 * resolved value is what keeps the CSS media query in charge — so the page
 * follows the phone into dark at sunset without anything re-running here.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
  root.classList.toggle('dark', resolveTheme(theme) === 'dark')
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // Unstorable, but still worth applying for this page view.
  }
  applyTheme(theme)
}

/**
 * The other one — a plain two-way switch, as Spare has always had.
 *
 * "system" survives as the starting point, so somebody who never touches
 * the switch still follows their phone into dark at sunset. It is simply
 * not a third stop on the way round: from system you get the opposite of
 * whatever you are looking at, which is the only thing pressing a switch
 * can be asking for.
 */
export function nextTheme(theme: Theme): 'light' | 'dark' {
  return resolveTheme(theme) === 'dark' ? 'light' : 'dark'
}

/**
 * Apply the stored choice and keep following the system while on "system".
 * Returns the unsubscribe, so a caller in React can clean up.
 */
export function startTheme(): () => void {
  applyTheme(readTheme())

  const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
  const onSystemChange = () => {
    if (readTheme() === 'system') applyTheme('system')
  }
  mq?.addEventListener?.('change', onSystemChange)

  /*
   * The other modules are separate documents on the same origin, so a
   * choice made in one arrives here as a storage event — but only when
   * that document is open at the same time, which for a tab left behind
   * on another module is exactly the case worth handling.
   */
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_KEY) applyTheme(readTheme())
  }
  window.addEventListener('storage', onStorage)

  return () => {
    mq?.removeEventListener?.('change', onSystemChange)
    window.removeEventListener('storage', onStorage)
  }
}
