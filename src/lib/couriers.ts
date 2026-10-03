/**
 * The couriers spares travel by, as a fixed list (3 Oct: "do option 1 with
 * courier dropdown"). Typed by hand they came in as "Trackon", "Track on"
 * and "Trac on"; rl_0043 put the old ones right. Anything else is "Other",
 * typed.
 */
export const COURIERS = ['DTDC', 'Trackon', 'Speed and Safe', 'Professional Couriers', 'Porter', 'By hand'] as const

/** A typed name read as one of the list, or left as it was. */
export function courierName(raw: string | null | undefined): string {
  const s = (raw ?? '').trim()
  const k = s.toLowerCase().replace(/[^a-z]/g, '')
  if (k === 'dtdc') return 'DTDC'
  if (/^tra(c|ck)on$/.test(k)) return 'Trackon'
  if (/^speed(and)?safe$/.test(k)) return 'Speed and Safe'
  if (k.startsWith('professional')) return 'Professional Couriers'
  if (k === 'porter') return 'Porter'
  if (k === 'byhand') return 'By hand'
  return s
}

/**
 * Where to see a shipment, free, on the courier's own site.
 *
 * DTDC's page takes the AWB in its address (its old tracking link now
 * redirects to this one). Trackon's and Professional Couriers' pages take
 * it only in a box, so the AWB is copied as the page opens, to be pasted
 * there. 17TRACK read DTDC numbers as GLS Italy (the user, 3 Oct), so it is
 * used only for a courier typed under Other. Speed and Safe has no public
 * tracking page that could be found, and a spare carried by hand has
 * nothing to track.
 */
export function tracking(courier: string | null | undefined, awb: string | null | undefined): { url: string; paste: boolean } | null {
  const n = (awb ?? '').replace(/\s/g, '')
  const c = courierName(courier)
  if (n.length < 6) return null
  if (c === 'DTDC') return { url: 'https://www.dtdc.com/track-your-shipment/?awb=' + encodeURIComponent(n), paste: false }
  if (c === 'Trackon') return { url: 'https://trackon.in/courier-tracking', paste: true }
  if (c === 'Professional Couriers') return { url: 'https://www.tpcindia.com/', paste: true }
  if (!c || c === 'By hand' || c === 'Porter' || c === 'Speed and Safe' || /^na$/i.test(c)) return null
  return { url: 'https://t.17track.net/en#nums=' + encodeURIComponent(n), paste: false }
}
