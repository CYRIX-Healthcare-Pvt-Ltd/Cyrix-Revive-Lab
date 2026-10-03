import { useState } from 'react'
import { COURIERS, courierName } from '@/lib/couriers'

/** The courier, from the list; "Other" opens a box to type one. */
export default function CourierSelect({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  const known = (COURIERS as readonly string[]).includes(courierName(value))
  const [other, setOther] = useState(!!value && !known)
  return (
    <div className={className}>
      <select className="input" value={other ? '__other' : known ? courierName(value) : ''}
        onChange={e => { const v = e.target.value; if (v === '__other') { setOther(true); onChange('') } else { setOther(false); onChange(v) } }}>
        <option value="">Choose…</option>
        {COURIERS.map(c => <option key={c} value={c}>{c}</option>)}
        <option value="__other">Other…</option>
      </select>
      {other && <input className="input mt-2" value={value} onChange={e => onChange(e.target.value)} placeholder="Courier name" autoFocus />}
    </div>
  )
}
