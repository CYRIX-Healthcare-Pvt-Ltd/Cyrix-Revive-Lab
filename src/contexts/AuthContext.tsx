import {
  createContext, useContext, useEffect, useState, useCallback, type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import type { Me } from '@/lib/tickets'

/**
 * Who is here, and what they hold in Revive Lab.
 *
 * There is no sign-in screen in this app. The portal at app.cyrix.in owns
 * signing in, and every module is served from that same origin, so the
 * session the portal stored is already in this page's storage when it
 * opens — the same one KPI, Spare and BEMMP read. Somebody who arrives
 * without one is sent to the portal to sign in, and comes back through
 * its tile.
 */

export interface Employee {
  id: string
  ecode: string
  full_name: string
  designation: string | null
  avatar: string | null
}

interface AuthState {
  session: Session | null
  employee: Employee | null
  /** Revive Lab boxes and Revive Labs. Null until loaded. */
  me: Me | null
  /** May open the module: granted it, or holding a box in it. */
  hasAccess: boolean
  loading: boolean
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [session, setSession] = useState<Session | null>(null)
  const [employee, setEmployee] = useState<Employee | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [hasAccess, setHasAccess] = useState(false)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (uid: string | undefined) => {
    if (!uid) {
      setEmployee(null); setMe(null); setHasAccess(false)
      return
    }
    // Filtered to this person explicitly: the employees policy also shows
    // your manager and your reports, so an unfiltered single-row read
    // sees several rows and returns nobody.
    const [emp, mine, access] = await Promise.all([
      supabase.from('employees')
        .select('id, ecode, full_name, designation, avatar')
        .eq('auth_user_id', uid).maybeSingle(),
      supabase.rpc('revive_me'),
      supabase.rpc('revive_has_access'),
    ])
    setEmployee((emp.data as Employee | null) ?? null)
    const row = Array.isArray(mine.data) ? mine.data[0] : null
    setMe(row ? { ...row, trc_ids: row.trc_ids ?? [] } as Me : null)
    setHasAccess(access.data === true)
  }, [])

  useEffect(() => {
    let alive = true
    supabase.auth.getSession().then(async ({ data }) => {
      if (!alive) return
      setSession(data.session)
      await load(data.session?.user.id)
      if (alive) setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      // Signed out in another module on this origin: nothing here is still
      // true, and a cached ticket list must not outlive the person it was
      // fetched for.
      if (!s) {
        qc.clear(); setSession(null); setEmployee(null); setMe(null); setHasAccess(false)
        return
      }
      // Signed in (here, or in another tab): load who they are before the
      // app renders for them. A token refresh is the same person and needs
      // nothing reloaded.
      if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        setLoading(true)
        // Deferred out of the callback: supabase-js holds a lock while it
        // runs, and querying from inside it can wait on itself.
        setTimeout(() => {
          void load(s.user.id).finally(() => { setSession(s); setLoading(false) })
        }, 0)
        return
      }
      setSession(s)
    })
    return () => { alive = false; sub.subscription.unsubscribe() }
  }, [load, qc])

  const signOut = useCallback(async () => {
    await supabase.auth.signOut()
    qc.clear()
  }, [qc])

  const refresh = useCallback(async () => {
    await load(session?.user.id)
  }, [load, session])

  return (
    <AuthContext.Provider value={{ session, employee, me, hasAccess, loading, signOut, refresh }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
