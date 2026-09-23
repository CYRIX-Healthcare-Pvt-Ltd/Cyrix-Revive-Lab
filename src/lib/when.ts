/**
 * Dates and times, as people here read them: "21 Sept 2026, 11:53 AM".
 *
 * The time is always twelve-hour with AM or PM. It followed the device, and
 * a phone or laptop set to a 24-hour clock showed 14:02, which is not what
 * anybody here reads a time as (the user, 23 Sep). The date keeps the
 * device's own way of writing it, as before.
 */

const clock12 = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })

const toDate = (at: string | number | Date) => (at instanceof Date ? at : new Date(at))

/** "11:53 AM" */
export const clockTime = (at: string | number | Date): string => clock12.format(toDate(at))

/** "21 Sept 2026" — or "21 Sept" without the year. */
export const dayDate = (at: string | number | Date, withYear = true): string =>
  toDate(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) })

/** "21 Sept 2026, 11:53 AM" — or "21 Sept, 11:53 AM" without the year. */
export const dateTime = (at: string | number | Date, withYear = true): string =>
  `${dayDate(at, withYear)}, ${clockTime(at)}`

/**
 * How long between two moments, short enough to sit on the line between
 * two steps of a history: "<1m", "9m", "2h 5m", "3d 4h".
 */
export function gapLabel(ms: number): string {
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
  if (!Number.isFinite(ms) || ms < MIN) return '<1m'
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / HOUR)
  const m = Math.floor((ms % HOUR) / MIN)
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

/** The same, said in full for a screen reader: "2 hours 5 minutes". */
export function gapWords(ms: number): string {
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR
  if (!Number.isFinite(ms) || ms < MIN) return 'under a minute'
  const d = Math.floor(ms / DAY)
  const h = Math.floor((ms % DAY) / HOUR)
  const m = Math.floor((ms % HOUR) / MIN)
  const part = (n: number, unit: string) => (n > 0 ? `${n} ${unit}${n === 1 ? '' : 's'}` : '')
  return [part(d, 'day'), part(h, 'hour'), d > 0 ? '' : part(m, 'minute')].filter(Boolean).join(' ')
}
