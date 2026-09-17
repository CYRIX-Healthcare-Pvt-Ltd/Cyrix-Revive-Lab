import type { Trc } from '@/lib/queries'

/**
 * Revive Labs as a select's options, grouped by the state they serve — the
 * state named first, other states alphabetically, the Regional ones last —
 * so the list says why each one is in it.
 */
export default function LabOptions({ labs, first }: { labs: readonly Trc[]; first?: string | null }) {
  const groups = new Map<string, Trc[]>()
  for (const lab of labs) {
    const key = lab.state ?? ''
    groups.set(key, [...(groups.get(key) ?? []), lab])
  }
  const order = (a: string, b: string) =>
    a === b ? 0
      : a === first ? -1 : b === first ? 1
        : a === '' ? 1 : b === '' ? -1
          : a.localeCompare(b)
  return (
    <>
      {[...groups.keys()].sort(order).map(key => (
        <optgroup key={key || 'regional'} label={key || 'Regional — every state'}>
          {groups.get(key)!.map(lab => <option key={lab.id} value={lab.id}>{lab.name}</option>)}
        </optgroup>
      ))}
    </>
  )
}
