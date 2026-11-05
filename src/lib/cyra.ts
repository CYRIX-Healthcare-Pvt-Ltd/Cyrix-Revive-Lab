/**
 * Opening CYRA from Revive Lab, and asking CYRA whether a repair is recorded there.
 * Both use the person's own portal session: CYRA then sees only the tickets Revive Lab
 * already shows them (revive_can_see). Rules and settings are in ./cyraLink.ts.
 */
import { supabase } from '@/lib/supabase'
import { CYRA_API, cyraLink } from '@/lib/cyraLink'

/** A fresh access token: CYRA accepts a hand-off token only for a few minutes after it was issued. */
async function freshToken(): Promise<string | null> {
  const { data } = await supabase.auth.refreshSession()
  return data.session?.access_token ?? (await supabase.auth.getSession()).data.session?.access_token ?? null
}

/**
 * Open CYRA (on My RL tickets, or straight on one ticket) in its own window. The window is opened
 * before the token is fetched, so a pop-up blocker treats it as the click it came from.
 */
export async function openCyra(ticketId?: string | null): Promise<void> {
  const win = window.open('', 'cyra')
  const token = await freshToken()
  if (!token) {
    win?.close()
    throw new Error('Your sign-in has expired. Sign in again, then open CYRA.')
  }
  const link = cyraLink(token, ticketId)
  if (win) win.location.href = link
  else window.location.assign(link)
}

export type CyraCheck = 'recorded' | 'not_recorded' | 'unknown'

/** Is this repair recorded in CYRA? 'unknown' when CYRA cannot be reached — never a reason to block. */
export async function cyraRecorded(ticketId: string): Promise<CyraCheck> {
  try {
    const token = await freshToken()
    if (!token) return 'unknown'
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 8000)
    const res = await fetch(`${CYRA_API}/api/lab/rl-status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pt: token, ticket_id: ticketId }), signal: ctl.signal,
    }).finally(() => clearTimeout(timer))
    if (!res.ok) return 'unknown'
    const body = (await res.json()) as { visible?: boolean; recorded?: boolean }
    if (!body.visible) return 'unknown'
    return body.recorded ? 'recorded' : 'not_recorded'
  } catch {
    return 'unknown'
  }
}
