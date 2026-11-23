/**
 * CYRA — where a Revive Lab repair's technical knowledge is recorded (app.cyrix.in/cyra).
 * Revive Lab keeps the logistics (spares, parts, transfers, courier, closing); CYRA keeps what
 * was measured, what was ruled out and what fixed it. The RL number joins the two.
 *
 * Pure rules and settings here (no network), so they can be tested; opening CYRA and asking it
 * about a ticket is in ./cyra.ts.
 */

/** CYRA's app. Opened with the person's own portal session, like the portal's own CYRA tile. */
export const CYRA_URL = ((import.meta.env.VITE_CYRA_URL as string | undefined) || 'https://app.cyrix.in/cyra').replace(/\/$/, '')
/** CYRA's API, asked "is this repair recorded?" before a repair is closed. */
export const CYRA_API = ((import.meta.env.VITE_CYRA_API as string | undefined) || 'https://cyra-diagnostic-chat-1.onrender.com').replace(/\/$/, '')
/**
 * Off until the owner switches CYRA on for Revive Lab engineers: then Close repair waits for the
 * repair to be recorded in CYRA. A CYRA outage never blocks closing (the check is skipped).
 */
export const CYRA_RECORD_REQUIRED = import.meta.env.VITE_CYRA_RECORD_REQUIRED === 'true'

/** Who may open CYRA from Revive Lab. Admins only while the owner trials it (2026-10-24) — the one place to widen. */
export function canUseCyra(me: { is_admin?: boolean } | null | undefined): boolean {
  return !!me?.is_admin
}

/** Tickets still being worked: the ones CYRA lists and records against. */
export const CYRA_OPEN_STATUSES = ['approved', 'accepted', 'assigned', 'in_repair', 'parts_requested', 'parts_ordered',
  'parts_ready', 'pi_requested'] as const

/** The hand-off link. The token rides in the #fragment, which is never sent to a server or kept in history. */
export function cyraLink(accessToken: string, ticketId?: string | null): string {
  const rl = ticketId && /^[0-9a-fA-F-]{36}$/.test(ticketId) ? `&rl=${ticketId}` : ''
  return `${CYRA_URL}/sso#pt=${encodeURIComponent(accessToken)}&to=rl${rl}`
}
