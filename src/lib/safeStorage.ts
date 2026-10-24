/*
  Storage the browser refuses, made harmless before anything else runs (the user, 24 Oct: E2439's phone showed
  "Something went wrong — Failed to read the 'localStorage' property from 'Window': Access is denied", even after
  closing). Some in-app browsers (WhatsApp, Teams, Gmail) and phones that block cookies and site data throw on the
  mere mention of localStorage — the sign-in, the theme and every library that reads it then crash the page. Imported
  first in main.tsx: where storage is refused, window.localStorage and window.sessionStorage become a store in memory
  for the visit, so the app works and only the sign-in is not remembered next time.
*/
function memory(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size },
    clear: () => m.clear(),
    getItem: k => (m.has(k) ? m.get(k)! : null),
    key: i => [...m.keys()][i] ?? null,
    removeItem: k => { m.delete(k) },
    setItem: (k, v) => { m.set(k, String(v)) },
  }
}
for (const name of ['localStorage', 'sessionStorage'] as const) {
  try {
    const s = window[name]
    s.setItem('__cyrix_probe__', '1'); s.removeItem('__cyrix_probe__')
  } catch {
    try { Object.defineProperty(window, name, { value: memory(), configurable: true }) } catch { /* nothing more can be done */ }
  }
}
export {}
