/**
 * Signed out after 3 hours with nothing done (the user, 10 Oct: "auto
 * logout ... on inactive 3 hrs").
 *
 * One clock for the whole platform: activity anywhere on app.cyrix.in —
 * the portal, KPI, Revive Lab, My Task, Travel — is written to the same
 * localStorage key, so working in one keeps the others signed in. A
 * minute before, a bar says so with a "Stay signed in" button. Coming
 * back to a computer left overnight signs out on the spot.
 *
 * Not the installed app: a phone has its own lock, and a field engineer
 * signing in every time they open it would stop opening it. Not the
 * device's notifications either — they stay with the person; only
 * pressing Sign out takes them off.
 *
 * Hours (and whether the installed app is included) come from
 * app_settings.idle_sign_out, so they can change without a deploy.
 *
 * The same file is in every Cyrix app's src/lib/idleSignOut.ts — change
 * one, change them all. No React: it draws its own bar.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

const LAST = 'cyrix.lastActive'
const WARN_MS = 60_000

const read = () => { try { return Number(localStorage.getItem(LAST) ?? 0) } catch { return 0 } }
const touch = () => { try { localStorage.setItem(LAST, String(Date.now())) } catch { /* private window */ } }
const installed = () => {
  try {
    return window.matchMedia('(display-mode: standalone)').matches
      || (navigator as { standalone?: boolean }).standalone === true
  } catch { return false }
}

export function startIdleSignOut(db: SupabaseClient | null | undefined): void {
  if (!db || typeof window === 'undefined') return
  let limit = 3 * 3600_000
  let includeApp = false
  void db.from('app_settings').select('value').eq('key', 'idle_sign_out').maybeSingle()
    .then(({ data }) => {
      const v = data?.value as { hours?: number; installed_app?: boolean } | undefined
      if (v?.hours && v.hours > 0) limit = v.hours * 3600_000
      includeApp = !!v?.installed_app
    }, () => {})

  // Activity, written at most every 15 seconds.
  let wrote = 0
  const active = () => {
    const t = Date.now()
    if (t - wrote > 15_000) { wrote = t; touch() }
    if (bar) hide()
  }
  for (const e of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
    window.addEventListener(e, active, { passive: true, capture: true })
  }
  // A fresh sign-in starts the clock again, or yesterday's would end it at
  // once. Only a real one: Supabase says SIGNED_IN again whenever the tab
  // comes back into focus, and that is not somebody doing anything.
  let hadSession: boolean | null = null
  void db.auth.getSession().then(({ data }) => { if (hadSession === null) hadSession = !!data.session })
  db.auth.onAuthStateChange((ev, session) => {
    if (ev === 'SIGNED_IN' && hadSession === false) touch()
    if (ev !== 'TOKEN_REFRESHED') hadSession = !!session
  })

  // ---- the bar ----
  let bar: HTMLDivElement | null = null
  let tick: number | undefined
  const hide = () => { bar?.remove(); bar = null; window.clearInterval(tick); tick = undefined }
  const show = () => {
    if (bar) return
    bar = document.createElement('div')
    bar.setAttribute('role', 'alert')
    // At the top, under the header, the full width it needs: at the bottom it
    // sat over the phone's tab bar, squeezed into a column (the user, 10 Oct).
    bar.style.cssText = 'position:fixed;left:50%;top:calc(env(safe-area-inset-top) + 72px);transform:translateX(-50%);z-index:2147483000;'
      + 'display:flex;align-items:center;gap:12px;width:min(520px,calc(100% - 32px));box-sizing:border-box;padding:12px 16px;border-radius:12px;'
      + 'background:#111318;color:#f4f5f7;box-shadow:0 10px 30px rgba(0,0,0,.35);font:500 14px/1.4 system-ui,sans-serif;'
    const text = document.createElement('span')
    text.style.cssText = 'flex:1;min-width:0;'
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.textContent = 'Stay signed in'
    btn.style.cssText = 'flex-shrink:0;padding:8px 14px;border:0;border-radius:8px;background:#ce2434;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;'
    btn.onclick = () => { wrote = 0; active() }
    bar.append(text, btn)
    document.body.appendChild(bar)
    const paint = () => {
      const left = Math.max(0, Math.ceil((read() + limit - Date.now()) / 1000))
      text.textContent = `You will be signed out in 0:${String(Math.min(left, 59)).padStart(2, '0')} — no activity for ${limit / 3600_000} hour${limit === 3600_000 ? "" : "s"}`
    }
    paint()
    tick = window.setInterval(paint, 1000)
  }

  // ---- the check ----
  let leaving = false
  const check = async () => {
    if (leaving) return
    const { data: { session } } = await db.auth.getSession()
    if (!session) { hide(); return }
    if (installed() && !includeApp) { hide(); return }
    const last = read()
    if (!last) { touch(); return }
    const idle = Date.now() - last
    if (idle >= limit) {
      leaving = true
      hide()
      await db.auth.signOut({ scope: 'local' })
      window.location.assign(window.location.hostname === 'app.cyrix.in' ? '/' : window.location.pathname)
    } else if (idle >= limit - WARN_MS) show()
    else hide()
  }
  window.setInterval(() => { void check() }, 10_000)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check() })
  void check()
}
