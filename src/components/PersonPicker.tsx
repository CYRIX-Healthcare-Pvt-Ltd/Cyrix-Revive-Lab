import { useState } from 'react'
import { Search, X } from 'lucide-react'
import { useFindPeople, type Person } from '@/lib/queries'
import { Spinner } from '@/components/ui'

/**
 * Finds one person by employee code or name.
 *
 * Through revive_find_people rather than the employees table, which only
 * shows anybody their own manager and reports: a coordinator naming the
 * field engineer who sent a spare has to be able to find anyone.
 */
export default function PersonPicker({
  value, onChange, placeholder = 'Employee code or name', id,
}: {
  value: Person | null
  onChange: (p: Person | null) => void
  placeholder?: string
  id?: string
}) {
  const [q, setQ] = useState('')
  const { data, isFetching } = useFindPeople(q)

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-ink-200 bg-ink-50 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink-900">{value.full_name}</p>
          <p className="truncate text-xs text-ink-500">
            {value.ecode}{value.designation ? ` · ${value.designation}` : ''}
          </p>
        </div>
        <button type="button" className="btn-icon shrink-0" onClick={() => onChange(null)} aria-label="Choose somebody else">
          <X className="h-4 w-4" />
        </button>
      </div>
    )
  }

  const results = data ?? []
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
      <input
        id={id}
        className="input !pl-8"
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
      />
      {isFetching && <Spinner className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />}
      {q.trim().length >= 2 && !isFetching && (
        <ul className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-lg border border-ink-200 bg-surface shadow-lg">
          {results.length === 0 ? (
            <li className="px-3 py-2.5 text-sm text-ink-500">Nobody active matches “{q.trim()}”.</li>
          ) : results.map(p => (
            <li key={p.id}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left hover:bg-ink-50"
                onClick={() => { onChange(p); setQ('') }}
              >
                <span className="block text-sm font-medium text-ink-900">{p.full_name}</span>
                <span className="block text-xs text-ink-500">
                  {p.ecode}{p.designation ? ` · ${p.designation}` : ''}{p.department ? ` · ${p.department}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
