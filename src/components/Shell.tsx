import { NavLink, Outlet } from 'react-router-dom'
import clsx from 'clsx'
import { LayoutDashboard, ListChecks, PackagePlus, ShieldCheck, Grid2x2, LogOut } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useTickets } from '@/lib/queries'
import { waitingOnMe } from '@/lib/tickets'
import { Logo } from '@/components/Logo'
import ThemeToggle from '@/components/ThemeToggle'
import Avatar from '@/components/Avatar'

/**
 * The frame every Revive Lab screen sits in.
 *
 * KPI's header, part for part: the Cyrix lockup going back to the portal,
 * the tabs, the Modules link, the person, the theme switch and sign-out,
 * at the same heights and spacings. The platform's standing rule is that
 * the chrome is common to every module and only the tabs differ — moving
 * from KPI to here should feel like changing tab, not changing product.
 */
export default function Shell() {
  const { employee, me, signOut } = useAuth()
  const { data: tickets } = useTickets()
  const mine = (tickets ?? []).filter(t => waitingOnMe(t, me)).length

  /*
    Two names per tab. The header has room for the whole one; the bar at
    the bottom of a phone splits its width five ways, and "People & Revive
    Labs" beside "Raise ticket" ran straight into it.
  */
  const items: Array<{
    to: string; label: string; short: string
    icon: typeof LayoutDashboard; end?: boolean; badge?: number
  }> = [
    { to: '/', label: 'Dashboard', short: 'Home', icon: LayoutDashboard, end: true },
    { to: '/tickets', label: 'Tickets', short: 'Tickets', icon: ListChecks, badge: mine },
    { to: '/new', label: 'Raise ticket', short: 'Raise', icon: PackagePlus },
    ...(me?.is_admin
      ? [{ to: '/access', label: 'People & Revive Labs', short: 'People', icon: ShieldCheck }]
      : []),
  ]

  const handleSignOut = async () => {
    await signOut()
    // The portal owns the session: signing out here signs out of every
    // module, so the way back is the portal's door, not this app's.
    window.location.assign('/')
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-ink-200 bg-surface">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:h-16">
          {/* A plain anchor: the portal sits above this app's basename, so a
              router link to "/" would land back on this dashboard. */}
          <a
            href="/"
            className="btn-press flex shrink-0 items-center gap-2.5 rounded-lg py-1 pr-1"
            aria-label="All Cyrix modules"
            title="All Cyrix modules"
          >
            <Logo className="h-9 sm:h-11" />
          </a>

          <div className="relative ml-6 hidden min-w-0 flex-1 lg:block">
            <nav className="nav-scroll flex items-center gap-1 overflow-x-auto">
              {items.map(item => (
                <NavLink key={item.to} to={item.to} end={item.end} className="nav-link">
                  <item.icon className="h-4 w-4" />
                  {item.label}
                  <Badge count={item.badge} />
                </NavLink>
              ))}
              <a href="/" className="nav-link" title="All Cyrix modules">
                <Grid2x2 className="h-4 w-4 text-ink-400" />
                Modules
              </a>
            </nav>
          </div>

          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-3">
            {/* Who is signed in — shown, not a link. It used to open KPI's
                profile, which jumped people out of Revive Lab mid-task for
                a page they had not asked for. */}
            <div className="flex items-center gap-3 rounded-lg py-1 pl-2 pr-1">
              <span className="hidden text-right lg:block">
                <span className="block text-sm font-medium leading-tight text-ink-900">
                  {employee?.full_name}
                </span>
                <span className="block text-xs leading-tight text-ink-500">
                  {employee?.ecode}
                  {roleCaption(me)}
                </span>
              </span>
              <Avatar name={employee?.full_name} src={employee?.avatar} size="header" />
            </div>
            <ThemeToggle />
            <button onClick={handleSignOut} className="btn-icon" aria-label="Sign out" title="Sign out">
              <LogOut className="h-4.5 w-4.5 text-cyrixRed-600" />
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 pb-28 lg:pb-6">
        <Outlet />
      </main>

      {/* Phones and tablets: the tabs under the thumb, and the way out to
          the other modules as the last cell — as in KPI. */}
      <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-ink-200 bg-surface lg:hidden">
        <div
          className="grid"
          style={{ gridTemplateColumns: `repeat(${items.length + 1}, minmax(0, 1fr))` }}
        >
          {items.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => clsx(
                'relative flex min-w-0 flex-col items-center gap-1 px-1 py-2.5 text-[11px] font-medium transition-colors',
                isActive ? 'text-[color:var(--page-strong)]' : 'text-ink-400',
              )}
            >
              <span className="relative">
                <item.icon className="h-5 w-5" />
                {!!item.badge && item.badge > 0 && (
                  <span className="absolute -right-2 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-cyrixRed-600 px-1 text-[10px] font-bold text-white">
                    {item.badge > 99 ? '99+' : item.badge}
                  </span>
                )}
              </span>
              <span className="w-full truncate text-center">{item.short}</span>
            </NavLink>
          ))}
          <a
            href="/"
            className="relative flex min-w-0 flex-col items-center gap-1 px-1 py-2.5 text-[11px] font-medium text-ink-400 transition-colors"
          >
            <span className="relative"><Grid2x2 className="h-5 w-5" /></span>
            <span className="w-full truncate text-center">Modules</span>
          </a>
        </div>
      </nav>
    </div>
  )
}

/** " · Revive Lab Coordinator", " · Revive Lab Manager + Engineer" — what the boxes add up to. */
function roleCaption(me: ReturnType<typeof useAuth>['me']): string {
  if (!me) return ''
  const parts = [
    me.is_manager && 'Revive Lab Manager',
    me.is_coordinator && 'Revive Lab Coordinator',
    me.is_engineer && 'Revive Lab Engineer',
  ].filter(Boolean) as string[]
  if (parts.length === 0) return ''
  return ' · ' + parts[0] + (parts.length > 1 ? ` +${parts.length - 1}` : '')
}

/** Red because a badge here always means somebody is waiting on you. */
function Badge({ count }: { count?: number }) {
  if (!count || count <= 0) return null
  return (
    <span className="ml-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-cyrixRed-600 px-1.5 text-[11px] font-bold text-white">
      {count > 99 ? '99+' : count}
    </span>
  )
}
