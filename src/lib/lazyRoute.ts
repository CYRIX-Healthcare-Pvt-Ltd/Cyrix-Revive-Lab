import { lazy, type ComponentType } from 'react'

/**
 * A lazily-loaded page that survives a deploy.
 *
 * The reported symptom: a blank screen on signing in or on tapping a
 * tab, once in a while, fixed by refreshing. That shape — intermittent,
 * cured by a refresh, never reproducible on demand — is what a stale
 * chunk looks like from the outside.
 *
 * Every route in this app is a dynamic import, and each is a file with a
 * content hash in its name. A deploy replaces them all. Anyone whose tab
 * was already open is holding an index.html that names the OLD files, so
 * the moment they navigate, the browser asks for a chunk the CDN no
 * longer has. The import rejects, React unmounts the tree, and the
 * result is a white page — the app is fine, the person just has half of
 * yesterday's copy of it.
 *
 * A refresh fixes it because it fetches the new HTML, which is exactly
 * what this does for them, once, without their having to work it out.
 *
 * The guard is the important half. Reloading on a failure that a reload
 * cannot fix — a genuinely broken build, a network that is down — would
 * put somebody in a refresh loop with nothing on screen to explain it.
 * So it reloads at most once in ten seconds, and anything after that is
 * handed to the error boundary to be said out loud.
 */
const LAST_RELOAD = 'cyrix.chunkReloadAt'
const QUIET_PERIOD_MS = 10_000

const reloadedRecently = (): boolean => {
  try {
    const at = Number(sessionStorage.getItem(LAST_RELOAD) ?? 0)
    return Date.now() - at < QUIET_PERIOD_MS
  } catch {
    // Private browsing: no memory of a previous attempt, so refuse to
    // start a loop we would not be able to detect.
    return true
  }
}

const markReloaded = () => {
  try { sessionStorage.setItem(LAST_RELOAD, String(Date.now())) } catch { /* see above */ }
}

export function lazyRoute<
  // Matching React's own lazy(): pages take their own props, and
  // ComponentType<unknown> refuses any page that has some.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends ComponentType<any>,
>(
  load: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      return await load()
    } catch (err) {
      if (reloadedRecently()) throw err
      markReloaded()
      window.location.reload()
      // The page is on its way out; resolving anything here would only
      // render a frame that is about to be thrown away.
      return new Promise<{ default: T }>(() => {})
    }
  })
}
