import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { ArrowLeft, ArrowUpRight, ClipboardList, PackagePlus, Pencil, ShieldQuestion, Truck, UserRound, X } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { useBemmpProjects, useMembers, useRaiseTicket, useTickets, useTrcs, type Person, type Trc } from '@/lib/queries'
import { approversOf, cleanItems, orList, runsTrc, serves, stateLabel } from '@/lib/tickets'
import { STATES, districtsOf } from '@/lib/india'
import { uploadAttachment, type Slot } from '@/lib/attachments'
import { Alert, PageLoader, Spinner } from '@/components/ui'
import PersonPicker from '@/components/PersonPicker'
import IconChip from '@/components/IconChip'
import Dialog from '@/components/Dialog'
import LabOptions from '@/components/LabOptions'
import { MediaCapture, type PendingPhoto } from '@/components/Attachments'
import ItemsField, { newLine, type ItemLine } from '@/components/ItemsField'

/**
 * Raising a ticket — the route card, on a screen.
 *
 * Field engineers already send spares in with a paper card, form
 * CHPL/CRL/SRC, and this asks what the card asks. State comes first, and it
 * decides the rest: only that state's districts, and that state's BEMMPs and
 * Revive Labs beside the Regional ones, which serve every state. Sent by is
 * whoever is signed in, with their function, and never typed; Date of
 * dispatch is the inbound courier's date. The back of the card — Action
 * taken, Final status — belongs to the Close repair and Received back steps.
 *
 * Another state's Revive Lab is not in the list. It is asked for, with a
 * reason: the ticket is raised as waiting for approval, and once the
 * Regional Revive Lab admins approve it, the field engineer sends it
 * (rl_0014).
 *
 * Who is asking decides which card it is, and nobody is asked. A field
 * engineer sending a spare in raises it for themselves. A Revive Lab's
 * coordinator or manager raises it at their Revive Lab, for a spare that
 * arrived there from wherever, and names the field engineer it belongs to —
 * the desk does not send spares in, so it is not offered the choice.
 */
export default function NewTicket() {
  const { me, employee } = useAuth()
  const navigate = useNavigate()
  const { data: trcs, isLoading } = useTrcs()
  const { data: bemmp } = useBemmpProjects()
  const { data: tickets } = useTickets()
  const { data: members } = useMembers()
  const raise = useRaiseTicket()

  const active = useMemo(() => (trcs ?? []).filter(t => t.is_active), [trcs])
  const deskTrcs = useMemo(() => active.filter(t => runsTrc(me, t.id)), [active, me])
  const atLab = deskTrcs.length > 0

  const [trcId, setTrcId] = useState('')
  // Another state's Revive Lab, and why: raised as waiting for approval.
  const [far, setFar] = useState<{ trcId: string; reason: string } | null>(null)
  const [asking, setAsking] = useState(false)
  const [holder, setHolder] = useState<Person | null>(null)
  const [form, setForm] = useState({
    state: '', district: '', bemmpId: '', hospital: '', equipmentBarcode: '', equipmentName: '',
    sourceTicketNo: '', contactNumber: '', issue: '',
    returnAddress: '', inCourier: '', inAwb: '', inDispatchedOn: '',
    billingSpare: 'no' as 'yes' | 'no',
  })
  const [lines, setLines] = useState<ItemLine[]>(() => [newLine('spare')])
  const [photos, setPhotos] = useState<PendingPhoto[]>([])
  const [video, setVideo] = useState<Blob | null>(null)
  const [voice, setVoice] = useState<Blob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stage, setStage] = useState<'idle' | 'raising' | 'uploading'>('idle')

  /*
    The contact number starts as the official number on this person's KPI
    profile, and the return address as whatever they put on their last card.
    Only when the fields are still empty: nothing typed is ever overwritten.
  */
  useEffect(() => {
    if (!employee) return
    const last = (tickets ?? []).find(t => t.raised_by === employee.id && (t.contact_number || t.return_address))
    setForm(f => ({
      ...f,
      contactNumber: f.contactNumber || employee.official_phone || last?.contact_number || '',
      returnAddress: f.returnAddress || last?.return_address || '',
    }))
  }, [employee, tickets])

  const state = form.state
  const districts = districtsOf(state)
  const bemmpChoices = useMemo(() => (bemmp ?? []).filter(b => b.is_active && serves(b, state)), [bemmp, state])
  const labChoices = useMemo(
    () => (atLab ? deskTrcs : state ? active.filter(t => serves(t, state)) : []),
    [atLab, deskTrcs, active, state],
  )
  const elsewhere = useMemo(() => (atLab || !state ? [] : active.filter(t => !serves(t, state))), [atLab, active, state])
  const farLab = far ? active.find(t => t.id === far.trcId) ?? null : null
  const approvers = useMemo(() => approversOf(members ?? [], trcs ?? []), [members, trcs])
  // Pvt asks whether the spare is billed to the customer.
  const asksBilling = !!bemmpChoices.find(b => b.id === form.bemmpId)?.asks_billing

  // One Revive Lab to choose from: it is the answer, not a question.
  useEffect(() => {
    if (labChoices.length === 1) setTrcId(labChoices[0].id)
    else setTrcId(id => (labChoices.some(c => c.id === id) ? id : ''))
  }, [labChoices])

  const set = (k: keyof typeof form) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }))

  const chooseState = (next: string) => {
    setForm(f => {
      // A district belongs to one state. A BEMMP belongs to one, or to every state.
      const keep = (bemmp ?? []).some(b => b.id === f.bemmpId && serves(b, next))
      return { ...f, state: next, district: '', bemmpId: keep ? f.bemmpId : '', billingSpare: keep ? f.billingSpare : 'no' }
    })
    setFar(null)
  }

  const closeAsking = useCallback(() => setAsking(false), [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    if (!form.state) { setError('Choose the state.'); return }
    if (!form.district) { setError('Choose the district.'); return }
    if (!form.bemmpId) { setError('Choose the BEMMP.'); return }
    if (!far && !trcId) { setError('Choose the Revive Lab the spare is going to.'); return }
    if (form.hospital.trim().length < 2) { setError('Enter the hospital name.'); return }
    const items = cleanItems(lines)
    if (items.length === 0) { setError('Enter the spare name.'); return }
    if (items.some(i => i.name.length < 2)) { setError('Enter the name of each spare and accessory.'); return }
    if (form.issue.trim().length < 3) { setError('Describe the issue identified.'); return }
    if (form.returnAddress.trim().length < 5) { setError('Enter the spare return address.'); return }
    if (atLab && !holder) { setError('Name the field engineer this spare belongs to.'); return }

    let created: { id: string; code: string } | null = null
    try {
      setStage('raising')
      created = await raise.mutateAsync({
        ...form, items,
        trcId: far ? far.trcId : trcId,
        approvalReason: far ? far.reason : null,
        stakeholderId: atLab ? holder!.id : null,
        billingSpare: asksBilling ? form.billingSpare === 'yes' : null,
      })
    } catch (err) {
      setStage('idle')
      setError(err instanceof Error ? err.message : 'Could not raise that ticket.')
      return
    }

    /*
      The ticket exists before its files do: the storage rules only let a
      file into a folder named for a ticket its sender raised. A file that
      fails does not undo the ticket — the ticket page offers the empty slot
      again, and says so.
    */
    setStage('uploading')
    const ticketId = created.id
    const jobs: Array<[string, Slot, Blob]> = [
      ...photos.map((p, i): [string, Slot, Blob] => [`photo ${i + 1}`, i === 0 ? 'image-1' : 'image-2', p.blob]),
      ...(video ? [['the video', 'video', video] as [string, Slot, Blob]] : []),
      ...(voice ? [['the voice note', 'voice', voice] as [string, Slot, Blob]] : []),
    ]
    const results = await Promise.allSettled(jobs.map(([, slot, blob]) => uploadAttachment(ticketId, slot, blob)))
    const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [jobs[i][0]] : []))

    setStage('idle')
    navigate(`/tickets/${created.code}`, {
      replace: true,
      state: failed.length ? { uploadFailed: failed } : undefined,
    })
  }

  if (isLoading) return <PageLoader />

  const busy = stage !== 'idle'

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <button type="button" onClick={() => navigate(-1)} className="inline-flex items-center gap-1.5 text-sm text-ink-600 hover:text-ink-900">
        <ArrowLeft className="h-4 w-4" /> Back
      </button>

      <div>
        <h1 className="text-xl font-semibold text-ink-900">Raise a ticket</h1>
        <p className="mt-0.5 text-sm text-ink-500">
          The spare&rsquo;s route card. It gets the next RL number when you raise it.
        </p>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      <form onSubmit={submit} className="space-y-4">
        {atLab && (
          <div className="card space-y-3 p-4">
            <h2 className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
              <IconChip icon={UserRound} tone="red" /> Whose spare it is
            </h2>
            <div>
              <span className="label">Field engineer it belongs to <Req /></span>
              <div className="mt-1"><PersonPicker value={holder} onChange={setHolder} /></div>
              <p className="mt-1 text-xs text-ink-500">They and their reporting manager follow this ticket as if they had raised it.</p>
            </div>
          </div>
        )}

        {/* The card, top to bottom. */}
        <div className="card space-y-3 p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
              <IconChip icon={ClipboardList} tone="sky" /> Service route card
            </h2>
            <span className="text-[11px] text-ink-400">Form CHPL/CRL/SRC</span>
          </div>

          {/* Where it is from decides where it can go: the state, then its
              districts, BEMMPs and Revive Labs, two by two like the rest. */}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="label">State <Req /></span>
              <select className="input mt-1" value={form.state} onChange={e => chooseState(e.target.value)}>
                <option value="">Choose…</option>
                {STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="label">District <Req /></span>
              <select className="input mt-1" value={form.district} onChange={set('district')} disabled={!state}>
                <option value="">{state ? 'Choose…' : 'Choose the state first'}</option>
                {districts.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>

            {/* Billing spare is a question about the BEMMP, so it shares its place. */}
            <div className={clsx('grid gap-3', asksBilling && 'grid-cols-2')}>
              <label className="block">
                <span className="label">BEMMP <Req /></span>
                <select
                  className="input mt-1"
                  value={form.bemmpId}
                  disabled={!state}
                  // Another BEMMP starts the answer again from No.
                  onChange={e => setForm(f => ({ ...f, bemmpId: e.target.value, billingSpare: 'no' }))}
                >
                  <option value="">{state ? 'Choose…' : 'Choose the state first'}</option>
                  {bemmpChoices.map(b => <option key={b.id} value={b.id}>{b.code}</option>)}
                </select>
              </label>
              {asksBilling && (
                <label className="block">
                  <span className="label">Billing spare</span>
                  <select
                    className="input mt-1"
                    value={form.billingSpare}
                    onChange={e => setForm(f => ({ ...f, billingSpare: e.target.value as 'yes' | 'no' }))}
                  >
                    <option value="no">No</option>
                    <option value="yes">Yes</option>
                  </select>
                </label>
              )}
            </div>

            <div>
              {far && farLab ? (
                <>
                  <span className="label">Revive Lab <Req /></span>
                  <FarChoice lab={farLab} reason={far.reason} onChange={() => setAsking(true)} onUndo={() => setFar(null)} />
                </>
              ) : (
                <label className="block">
                  <span className="label">Revive Lab <Req /></span>
                  <select className="input mt-1" value={trcId} onChange={e => setTrcId(e.target.value)} disabled={!atLab && !state}>
                    <option value="">{atLab || state ? 'Choose…' : 'Choose the state first'}</option>
                    <LabOptions labs={labChoices} first={state} />
                  </select>
                </label>
              )}
              {!far && elsewhere.length > 0 && (
                <button type="button" onClick={() => setAsking(true)} className="link-accent mt-2 inline-flex items-center gap-1.5 text-sm font-medium">
                  <ArrowUpRight className="h-4 w-4" /> Send to another state&rsquo;s Revive Lab
                </button>
              )}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Hospital name" value={form.hospital} onChange={set('hospital')} required />
            <Field label="Equipment barcode" value={form.equipmentBarcode} onChange={set('equipmentBarcode')} mono />
            <Field label="Equipment name" value={form.equipmentName} onChange={set('equipmentName')} placeholder="e.g. Ventilator" />
            {/* In Spare name's place on the card, grown into a list. */}
            <ItemsField lines={lines} onChange={setLines} required />
            <Field label="Ticket ID" value={form.sourceTicketNo} onChange={set('sourceTicketNo')} placeholder="The field service ticket" mono />
            <Field label="Contact number" type="tel" value={form.contactNumber} onChange={set('contactNumber')} placeholder="+91 …" />
          </div>

          <label className="block">
            <span className="label">Issue identified <Req /></span>
            <textarea className="input mt-1" rows={3} value={form.issue} onChange={set('issue')} maxLength={2000}
              placeholder="What is wrong with it, as found on site" />
          </label>

          {/* Photos, the video and the voice note, side by side. */}
          <div>
            <span className="label">Photos and recordings</span>
            <div className="mt-1">
              <MediaCapture
                photos={{ value: photos, onChange: setPhotos }}
                video={{ value: video, onChange: setVideo }}
                voice={{ value: voice, onChange: setVoice }}
              />
            </div>
          </div>

          <label className="block">
            <span className="label">Spare return address <Req /></span>
            <textarea className="input mt-1" rows={2} value={form.returnAddress} onChange={set('returnAddress')} maxLength={500}
              placeholder="Where the Revive Lab sends it back to" />
          </label>
        </div>

        <div className="card space-y-3 p-4">
          <div>
            <h2 className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
              <IconChip icon={Truck} tone="teal" /> Courier details
            </h2>
            <p className="mt-1 text-xs text-ink-500">
              {far
                ? 'It waits for approval first. Send the spare once it is approved — these can be added then.'
                : 'No tracking number yet? Raise the ticket now and add these from the ticket once it is sent.'}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Courier" value={form.inCourier} onChange={set('inCourier')} placeholder="DTDC, Blue Dart…" />
            <Field label="Tracking / AWB number" value={form.inAwb} onChange={set('inAwb')} mono />
            <Field label="Date of dispatch" type="date" value={form.inDispatchedOn} onChange={set('inDispatchedOn')} />
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {far && (
            <p className="w-full text-xs text-ink-500 sm:mr-auto sm:w-auto">
              {approvers.length ? `${orList(approvers)} approves` : 'The Regional Revive Lab admins approve'} it before you send it.
            </p>
          )}
          <button type="button" className="btn-secondary" onClick={() => navigate(-1)} disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? <Spinner className="h-4 w-4" /> : far ? <ShieldQuestion className="h-4 w-4" /> : <PackagePlus className="h-4 w-4" />}
            {stage === 'raising' ? 'Raising…' : stage === 'uploading' ? 'Sending photos and recordings…' : far ? 'Ask for approval' : 'Raise ticket'}
          </button>
        </div>
      </form>

      {asking && (
        <AskAnotherState
          state={state}
          labs={elsewhere}
          approvers={approvers}
          initial={far}
          onClose={closeAsking}
          onChoose={pick => { setFar(pick); setAsking(false) }}
        />
      )}
    </div>
  )
}

/** Another state's Revive Lab, chosen: what it is, why, and the way back to the state's own list. */
function FarChoice({ lab, reason, onChange, onUndo }: {
  lab: Trc
  reason: string
  onChange: () => void
  onUndo: () => void
}) {
  return (
    <div className="mt-1 rounded-lg border border-fuchsia-200 bg-fuchsia-50 px-3 py-2">
      <div className="flex items-start gap-2">
        <ShieldQuestion className="mt-0.5 h-4 w-4 shrink-0 text-fuchsia-600" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink-900">{lab.name}</p>
          <p className="text-xs text-fuchsia-800">{stateLabel(lab.state)} · needs approval</p>
          <p className="mt-1 break-words text-xs text-ink-600">{reason}</p>
          <button type="button" onClick={onChange} className="link-accent mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-ink-700">
            <Pencil className="h-3 w-3" /> Change
          </button>
        </div>
        <button
          type="button"
          onClick={onUndo}
          className="btn-icon -mr-1.5 -mt-1 shrink-0"
          aria-label="Choose from this state's Revive Labs instead"
          title="Choose from this state's Revive Labs instead"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}

/**
 * Asking for another state's Revive Lab: which one, and why. Its own state,
 * so typing the reason does not redraw the whole route card underneath.
 */
function AskAnotherState({ state, labs, approvers, initial, onClose, onChoose }: {
  state: string
  labs: readonly Trc[]
  approvers: string[]
  initial: { trcId: string; reason: string } | null
  onClose: () => void
  onChoose: (pick: { trcId: string; reason: string }) => void
}) {
  const [trcId, setTrcId] = useState(initial?.trcId ?? (labs.length === 1 ? labs[0].id : ''))
  const [reason, setReason] = useState(initial?.reason ?? '')
  const [error, setError] = useState<string | null>(null)

  const choose = () => {
    if (!trcId) { setError('Choose the Revive Lab.'); return }
    if (reason.trim().length < 5) { setError('Say why it should go there.'); return }
    onChoose({ trcId, reason: reason.trim() })
  }

  return (
    <Dialog title="Another state’s Revive Lab" icon={<IconChip icon={ShieldQuestion} tone="fuchsia" />} onClose={onClose}>
      <p className="text-sm text-ink-600">
        The route card offers {state}&rsquo;s Revive Labs and the Regional ones. Any other is approved first by the
        Regional Revive Lab admins{approvers.length ? <> — {orList(approvers)}</> : null}. Raise the ticket now; once it
        is approved, you send it from the ticket.
      </p>
      <label className="block">
        <span className="label">Revive Lab <Req /></span>
        <select className="input mt-1" value={trcId} onChange={e => setTrcId(e.target.value)}>
          <option value="">Choose…</option>
          <LabOptions labs={labs} />
        </select>
      </label>
      <label className="block">
        <span className="label">Why this Revive Lab <Req /></span>
        <textarea
          className="input mt-1"
          rows={3}
          maxLength={500}
          value={reason}
          onChange={e => setReason(e.target.value)}
          placeholder="e.g. Needs FPGA rework that only they do"
        />
      </label>
      {error && <Alert kind="error">{error}</Alert>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={choose}>
          <ShieldQuestion className="h-4 w-4" /> Choose this Revive Lab
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  )
}

function Req() {
  return <span className="text-cyrixRed-600">*</span>
}

function Field({
  label, value, onChange, placeholder, type = 'text', required, mono,
}: {
  label: string
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
  type?: string
  required?: boolean
  mono?: boolean
}) {
  return (
    <label className="block">
      <span className="label">{label}{required && <> <Req /></>}</span>
      <input className={clsx('input mt-1', mono && 'font-mono')} type={type} value={value} onChange={onChange} placeholder={placeholder} />
    </label>
  )
}
