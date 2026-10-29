import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import {
  ArrowLeft, ArrowUpRight, ClipboardList, Copy, Hospital, PackagePlus, Pencil, ShieldQuestion, Truck, UserRound, Warehouse, X,
} from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import {
  useBemmpProjects, useOverdueReturns, useOverdueReturnsOf, usePhoneOf, useRaiseTicket, useTickets, useTrcs, useWarehouses, type Person, type Trc,
} from '@/lib/queries'
import {
  cleanItems, runsTrc, serves, stateLabel,
  type ContractType, type TicketStatus, type Criticality, type SpareCategory, type TicketSource,
} from '@/lib/tickets'
import Choices, { type ChoiceOption } from '@/components/Choices'
import { ClassificationFields } from '@/components/Classification'
import { STATES, districtsOf } from '@/lib/india'
import { uploadAttachment, type Slot } from '@/lib/attachments'
import { Alert, PageLoader, Spinner, StatusBadge, useError } from '@/components/ui'
import { supabase } from '@/lib/supabase'
import { dateTime } from '@/lib/when'
import PersonPicker from '@/components/PersonPicker'
import IconChip from '@/components/IconChip'
import Dialog from '@/components/Dialog'
import LabOptions from '@/components/LabOptions'
import { MediaCapture, type PendingPhoto } from '@/components/Attachments'
import ItemsField, { newLine, type ItemLine } from '@/components/ItemsField'
import CloseFirst from '@/components/CloseFirst'
import CourierSelect from '@/components/CourierSelect'

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
 * Another state's Revive Lab: where the BEMMP has a project head, it is
 * asked for with a reason and the head approves it before the field
 * engineer sends it; with no head it is simply in the list (rl_0049).
 *
 * Who is asking decides which card it is, and nobody is asked. A field
 * engineer sending a spare in raises it for themselves. A Revive Lab's
 * coordinator, or an admin, raises it at their own Revive Lab for that state,
 * for a spare that arrived there, and names whose it is: the field engineer,
 * or — for a warehouse's defective spare — the warehouse in-charge. A
 * warehouse card names the warehouse from a fixed list, and has no district,
 * BEMMP or ticket ID (rl_0020).
 *
 * A field engineer with a spare that came back and has waited past the days
 * set for its state — not confirmed arriving, or not closed — is shown those
 * tickets instead of the card, each opening its ticket (rl_0041). The
 * database refuses their raise too. Nor can the desk name a field engineer
 * who is held (rl_0042): picking one shows their tickets at once, and lets
 * go of them. A warehouse's in-charge is not held.
 */
type Similar = {
  id: string; code: string; status: TicketStatus; raised_by_name: string | null; holder_name: string | null; lab_name: string | null
  raised_at: string; facility: string | null; equipment_name: string | null; spare_name: string | null; matched: 'barcode' | 'equipment' | 'spare'
}

export default function NewTicket() {
  const { me, employee } = useAuth()
  const navigate = useNavigate()
  const { data: trcs, isLoading } = useTrcs()
  const { data: bemmp } = useBemmpProjects()
  const { data: tickets } = useTickets()
  const { data: warehouses } = useWarehouses()
  const { data: late, isLoading: checkingLate } = useOverdueReturns()
  const raise = useRaiseTicket()

  const active = useMemo(() => (trcs ?? []).filter(t => t.is_active), [trcs])
  const deskTrcs = useMemo(() => active.filter(t => runsTrc(me, t.id)), [active, me])
  const atLab = deskTrcs.length > 0

  const [trcId, setTrcId] = useState('')
  // Another state's Revive Lab, and why: raised as waiting for approval.
  const [far, setFar] = useState<{ trcId: string; reason: string } | null>(null)
  const [asking, setAsking] = useState(false)
  const [holder, setHolder] = useState<Person | null>(null)
  // The desk's own question: a hospital's spare, or a warehouse's (rl_0020).
  const [source, setSource] = useState<TicketSource>('hospital')
  const [warehouseId, setWarehouseId] = useState('')
  // A Pvt spare says which contract it is under (rl_0024).
  const [contractType, setContractType] = useState<ContractType | null>(null)
  // The desk's raise is its acceptance (rl_0023), so it says what the spare is now.
  const [category, setCategory] = useState<SpareCategory | null>(null)
  const [criticality, setCriticality] = useState<Criticality | null>(null)
  const [form, setForm] = useState({
    state: '', district: '', bemmpId: '', hospital: '', equipmentBarcode: '', equipmentName: '',
    equipmentMake: '', equipmentModel: '',
    sourceTicketNo: '', contactNumber: '', issue: '',
    returnAddress: '', inCourier: '', inAwb: '', inDispatchedOn: '',
    billingSpare: 'no' as 'yes' | 'no',
  })
  const [lines, setLines] = useState<ItemLine[]>(() => [newLine('spare')])
  const [photos, setPhotos] = useState<PendingPhoto[]>([])
  const [video, setVideo] = useState<Blob | null>(null)
  const [voice, setVoice] = useState<Blob | null>(null)
  const [error, setError, nth] = useError()
  const [stage, setStage] = useState<'idle' | 'raising' | 'uploading'>('idle')
  // The open tickets that look like this one, found before a coordinator raises it (rl_0053).
  const [dupes, setDupes] = useState<Similar[] | null>(null)

  /*
    The contact number starts as the official number on this person's KPI
    profile, and the return address as whatever they put on their last card.
    Only when the fields are still empty: nothing typed is ever overwritten.
  */
  // The number put in for them, so a field engineer chosen later can take its place; one typed is never replaced.
  const autoPhone = useRef('')
  useEffect(() => {
    if (!employee) return
    const last = (tickets ?? []).find(t => t.raised_by === employee.id && (t.contact_number || t.return_address))
    setForm(f => {
      const phone = f.contactNumber || employee.official_phone || last?.contact_number || ''
      if (!f.contactNumber) autoPhone.current = phone
      return { ...f, contactNumber: phone, returnAddress: f.returnAddress || last?.return_address || '' }
    })
  }, [employee, tickets])

  const state = form.state
  const fromWarehouse = atLab && source === 'warehouse'
  // The field engineer the desk names, and whether they are held (rl_0042).
  const named = (atLab || (!!me?.is_observer && !!me?.may_raise)) && !fromWarehouse ? holder : null
  const { data: namedLate } = useOverdueReturnsOf(named?.id ?? null)
  const namedHeld = !!named && (namedLate?.length ?? 0) > 0
  // The field engineer the desk or an observer names: their number, from their profile or their last card (the user, 23 Oct).
  const { data: namedPhone } = usePhoneOf(named?.id ?? null)
  useEffect(() => {
    if (!namedPhone) return
    setForm(f => {
      if (f.contactNumber && f.contactNumber !== autoPhone.current) return f
      autoPhone.current = namedPhone
      return { ...f, contactNumber: namedPhone }
    })
  }, [namedPhone])
  const districts = districtsOf(state)
  const bemmpChoices = useMemo(() => (bemmp ?? []).filter(b => b.is_active && serves(b, state)), [bemmp, state])
  // The state's own Revive Labs and the Regional ones — for the desk, only
  // those of its own. A Kerala card at the Jodhpur Revive Lab was offered once.
  const headId = (bemmp ?? []).find(b => b.id === form.bemmpId)?.head_id ?? null
  const labChoices = useMemo(
    // A warehouse's spare may go to any Revive Lab, not only the desk's own (the user, 29 Oct: "add that option ie send to other revive lab").
    () => (!state ? [] : fromWarehouse ? active : (atLab ? deskTrcs : active).filter(t => serves(t, state) || (!atLab && !headId))),
    [atLab, deskTrcs, active, state, headId, fromWarehouse],
  )
  const warehouseChoices = useMemo(
    () => (warehouses ?? []).filter(w => w.is_active && serves(w, state)),
    [warehouses, state],
  )
  // The BEMMP's project head approves another state's Revive Lab; with none, it is just another choice (rl_0049).
  const head = (bemmp ?? []).find(b => b.id === form.bemmpId && b.head_id) ?? null
  // The desk asks too, for a hospital's spare — any other state's Revive Lab, one it runs too (rl_0058, rl_0060;
  // the user, 28 Oct: "need it for coordinator also").
  const elsewhere = useMemo(() => (fromWarehouse || !state ? [] : active.filter(t => !serves(t, state))), [fromWarehouse, active, state])
  const asksHead = !!head && elsewhere.length > 0
  const farLab = far ? active.find(t => t.id === far.trcId) ?? null : null
  // Pvt asks whether the spare is billed to the customer.
  const asksBilling = !!bemmpChoices.find(b => b.id === form.bemmpId)?.asks_billing
  // Pvt asks the contract too: AMC, or CAMC — and a CAMC spare is always critical.
  const asksContract = !fromWarehouse && !!bemmpChoices.find(b => b.id === form.bemmpId)?.asks_contract
  const camc = asksContract && contractType === 'CAMC'
  // OTS / Stock asks no hospital and no photo (rl_0057).
  const ots = asksContract && contractType === 'OTS'
  // An observer ticked "May raise tickets" names the field engineer it belongs to, as the desk does (rl_0057).
  const observerRaise = !atLab && !!me?.is_observer && !!me?.may_raise
  const namesHolder = atLab || observerRaise
  useEffect(() => { if (!asksContract) setContractType(null) }, [asksContract])
  // A warehouse's spare has no BEMMP, so nobody to approve another state's Revive Lab.
  useEffect(() => { if (fromWarehouse) setFar(null) }, [fromWarehouse])
  // Asked for elsewhere, the desk does not accept it as it raises it: the Revive Lab it goes to classifies it on arrival.
  // Sent to another Revive Lab, it is that lab's to accept and classify.
  const classify = atLab && !far && (!fromWarehouse || !trcId || runsTrc(me, trcId))

  // One Revive Lab to choose from: it is the answer, not a question. The same for a warehouse.
  useEffect(() => {
    if (labChoices.length === 1) setTrcId(labChoices[0].id)
    else setTrcId(id => (labChoices.some(c => c.id === id) ? id : ''))
  }, [labChoices])
  useEffect(() => {
    if (warehouseChoices.length === 1) setWarehouseId(warehouseChoices[0].id)
    else setWarehouseId(id => (warehouseChoices.some(w => w.id === id) ? id : ''))
  }, [warehouseChoices])

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

  const submit = async (e?: React.FormEvent, sure = false) => {
    e?.preventDefault()
    setError(null)
    if (!form.state) { setError('Choose the state.'); return }
    if (!fromWarehouse && !form.district) { setError('Choose the district.'); return }
    if (!fromWarehouse && !form.bemmpId) { setError('Choose the BEMMP.'); return }
    if (!far && !trcId) { setError('Choose the Revive Lab the spare is going to.'); return }
    if (fromWarehouse && !warehouseId) { setError('Choose the warehouse.'); return }
    if (!fromWarehouse && !ots && form.hospital.trim().length < 2) { setError('Enter the hospital name.'); return }
    const items = cleanItems(lines)
    if (items.length === 0) { setError('Enter the spare name.'); return }
    if (items.some(i => i.name.length < 2)) { setError('Enter the name of each spare and accessory.'); return }
    if (form.issue.trim().length < 3) { setError('Describe the issue identified.'); return }
    // One photo of the spare at least, whoever raises it — field engineer or the desk (the user, 24 Sep).
    if (photos.length === 0 && !ots) { setError('Add a photo of the spare — one at least.'); return }
    if (form.returnAddress.trim().length < 5) { setError('Enter the spare return address.'); return }
    if (namesHolder && !holder) {
      setError(fromWarehouse ? 'Name the warehouse in-charge this spare belongs to.' : 'Name the field engineer this spare belongs to.')
      return
    }
    if (namedHeld) { setError(`${named!.full_name} has spares to close first — a ticket cannot be raised in their name yet.`); return }

    if (asksContract && !contractType) { setError('Choose the contract type — AMC, CAMC or OTS / Stock.'); return }
    if (classify && !category) { setError('Choose the spare category — A, B or C.'); return }
    if (classify && !camc && !criticality) { setError('Choose whether the spare is critical or non-critical.'); return }

    /*
      Already in Revive Lab? (the user, 19 Oct: an engineer raised hospital A's equipment B, and the
      coordinator raised the same again by mistake.) For a coordinator only: the open tickets at the same
      hospital with the same equipment or spare, with their number and who raised them. Cancel, or go on.
    */
    if (atLab && !fromWarehouse && !sure) {
      setStage('raising')
      const { data: like } = await supabase.rpc('revive_similar_tickets', {
        p_hospital: form.hospital, p_equipment_name: form.equipmentName, p_equipment_barcode: form.equipmentBarcode,
        p_spares: items.map(i => i.name),
      })
      setStage('idle')
      if (like && (like as Similar[]).length) { setDupes(like as Similar[]); return }
    }

    let created: { id: string; code: string } | null = null
    try {
      setStage('raising')
      created = await raise.mutateAsync({
        ...form, items,
        // A warehouse's card has none of these, whatever was typed before switching.
        ...(fromWarehouse ? { district: '', bemmpId: '', hospital: '', sourceTicketNo: '' } : {}),
        source: fromWarehouse ? 'warehouse' : 'hospital',
        warehouseId: fromWarehouse ? warehouseId : null,
        trcId: far ? far.trcId : trcId,
        approvalReason: far ? far.reason : null,
        stakeholderId: namesHolder ? holder!.id : null,
        billingSpare: !fromWarehouse && asksBilling ? form.billingSpare === 'yes' : null,
        contractType: asksContract ? contractType : null,
        category: classify ? category : null,
        criticality: classify ? (camc ? 'critical' : criticality) : null,
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

  if (isLoading || (!atLab && checkingLate)) return <PageLoader />

  // Spares that came back and were left past their state's limit: those first (rl_0041).
  if (!atLab && late && late.length > 0) {
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Raise a ticket</h1>
          <p className="mt-0.5 text-sm text-ink-500">Close the spares that came back to you, then raise a new one.</p>
        </div>
        <CloseFirst tickets={late} onClose={() => navigate('/tickets')} />
      </div>
    )
  }

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

      {dupes && (
        <Dialog title="Already in Revive Lab?" icon={<IconChip icon={Copy} tone="amber" />} onClose={() => setDupes(null)} wide>
          <p className="mt-2 text-sm text-ink-700">
            <b className="font-semibold text-ink-900">{form.hospital.trim()}</b> already has {dupes.length === 1 ? 'an open ticket' : `${dupes.length} open tickets`} for this equipment or spare.
          </p>
          <ul className="mt-3 space-y-2">
            {dupes.map(d => (
              <li key={d.id} className="rounded-xl border border-amber-300 bg-amber-50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-base font-bold text-ink-900">{d.code}</span>
                  <StatusBadge status={d.status} />
                </div>
                <p className="mt-1 text-sm text-ink-800">{[d.equipment_name, d.spare_name].filter(Boolean).join(' · ')}</p>
                <p className="mt-0.5 text-xs text-ink-600">
                  Raised by <b className="font-semibold text-ink-800">{d.raised_by_name ?? '—'}</b> · {dateTime(d.raised_at)}
                  {d.holder_name && d.holder_name !== d.raised_by_name ? ` · for ${d.holder_name}` : ''}{d.lab_name ? ` · ${d.lab_name}` : ''}
                </p>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setDupes(null)}>Cancel</button>
            <button type="button" className="btn-primary" onClick={() => { setDupes(null); void submit(undefined, true) }}>Continue anyway</button>
          </div>
        </Dialog>
      )}

      <form onSubmit={submit} className="space-y-4">
        {observerRaise && (
          <div className="card space-y-3 p-4">
            <h2 className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
              <IconChip icon={UserRound} tone="red" /> Whose spare it is
            </h2>
            <div>
              <span className="label">Field engineer it belongs to <Req /></span>
              <div className="mt-1"><PersonPicker value={holder} onChange={setHolder} /></div>
              {namedHeld && <CloseFirst tickets={namedLate!} who={named!.full_name} onClose={() => setHolder(null)} />}
            </div>
          </div>
        )}
        {atLab && (
          <div className="card space-y-3 p-4">
            <h2 className="flex items-center gap-2.5 text-sm font-semibold text-ink-800">
              <IconChip icon={UserRound} tone="red" /> Whose spare it is
            </h2>
            {/* A warehouse sends its defective spares in through the desk (rl_0020). */}
            <div>
              <span className="label">It comes from <Req /></span>
              <div className="mt-1 grid gap-2 sm:grid-cols-2">
                {(['hospital', 'warehouse'] as const).map(s => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setSource(s)}
                    aria-pressed={source === s}
                    className={clsx(
                      'flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                      source === s ? SOURCE_LOOK[s].on : SOURCE_LOOK[s].off,
                    )}
                  >
                    {s === 'hospital'
                      ? <Hospital className={clsx('h-4 w-4 shrink-0', SOURCE_LOOK.hospital.icon)} />
                      : <Warehouse className={clsx('h-4 w-4 shrink-0', SOURCE_LOOK.warehouse.icon)} />}
                    <span>
                      <span className="block text-sm font-medium text-ink-900">{s === 'hospital' ? 'A hospital' : 'A warehouse'}</span>
                      <span className="block text-xs text-ink-500">
                        {s === 'hospital' ? 'Sent in by a field engineer' : 'A defective spare from warehouse stock'}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="label">{fromWarehouse ? 'Warehouse in-charge' : 'Field engineer it belongs to'} <Req /></span>
              <div className="mt-1"><PersonPicker value={holder} onChange={setHolder} /></div>
              {namedHeld && <CloseFirst tickets={namedLate!} who={named!.full_name} onClose={() => setHolder(null)} />}
              <p className="mt-1 text-xs text-ink-500">They and their reporting manager follow this ticket as if they had raised it.</p>
            </div>
            {/* Raised here, it is accepted as it is raised: what it is, now (rl_0024). */}
            {classify && <div className="border-t border-ink-100 pt-3">
              <ClassificationFields
                category={category}
                criticality={criticality}
                onCategory={setCategory}
                onCriticality={setCriticality}
                camc={camc}
              />
              <p className="mt-1.5 text-xs text-ink-500">
                Raised here, it is accepted as it is raised — its TAT counts from now: A 3 days, B 2, C 1.
              </p>
            </div>}
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
            {!fromWarehouse && (
              <label className="block">
                <span className="label">District <Req /></span>
                <select className="input mt-1" value={form.district} onChange={set('district')} disabled={!state}>
                  <option value="">{state ? 'Choose…' : 'Choose the state first'}</option>
                  {districts.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
            )}

            {/* Billing spare is a question about the BEMMP, so it shares its place. */}
            {!fromWarehouse && <div className={clsx('grid gap-3', asksBilling && 'grid-cols-2')}>
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
            </div>}

            <div>
              {far && farLab ? (
                <>
                  <span className="label">Revive Lab <Req /></span>
                  <FarChoice lab={farLab} reason={far.reason} onChange={() => setAsking(true)} onUndo={() => setFar(null)} />
                </>
              ) : (
                <label className="block">
                  <span className="label">Revive Lab <Req /></span>
                  <select className="input mt-1" value={trcId} onChange={e => setTrcId(e.target.value)} disabled={!state}>
                    <option value="">{state ? 'Choose…' : 'Choose the state first'}</option>
                    <LabOptions labs={labChoices} first={state} />
                  </select>
                  {atLab && state && labChoices.length === 0 && (
                    <span className="mt-1 block text-xs text-cyrixRed-700">
                      None of your Revive Labs is for {state}. Its spares go to {state}&rsquo;s own Revive Lab, or a Regional one.
                    </span>
                  )}
                </label>
              )}
              {!far && asksHead && (
                <button type="button" onClick={() => setAsking(true)} className="link-accent mt-2 inline-flex items-center gap-1.5 text-sm font-medium">
                  <ArrowUpRight className="h-4 w-4" /> Send to another state&rsquo;s Revive Lab
                </button>
              )}
            </div>

            {asksContract && (
              <div className="sm:col-span-2">
                <Choices label="Contract type" options={CONTRACT_CHOICES} value={contractType} onChange={setContractType} required />
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {fromWarehouse ? (
              <label className="block">
                <span className="label">Warehouse <Req /></span>
                <select className="input mt-1" value={warehouseId} onChange={e => setWarehouseId(e.target.value)} disabled={!state}>
                  <option value="">{!state ? 'Choose the state first' : warehouseChoices.length ? 'Choose…' : 'No warehouse for this state'}</option>
                  {warehouseChoices.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
                {state && warehouseChoices.length === 0 && (
                  <span className="mt-1 block text-xs text-ink-500">A Revive Lab admin adds warehouses under People &amp; Revive Labs.</span>
                )}
              </label>
            ) : (
              <Field label="Hospital name" value={form.hospital} onChange={set('hospital')} required={!ots} />
            )}
            <Field label="Equipment barcode" value={form.equipmentBarcode} onChange={set('equipmentBarcode')} mono />
            <Field label="Equipment name" value={form.equipmentName} onChange={set('equipmentName')} placeholder="e.g. Ventilator" />
            {/* Beside the equipment they describe (rl_0019). */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Make" value={form.equipmentMake} onChange={set('equipmentMake')} placeholder="e.g. Philips" maxLength={80} />
              <Field label="Model" value={form.equipmentModel} onChange={set('equipmentModel')} placeholder="e.g. V60" maxLength={80} />
            </div>
            {/* In Spare name's place on the card, grown into a list — the whole width, so a line has room. */}
            <div className="sm:col-span-2">
              <ItemsField lines={lines} onChange={setLines} required machine={form.equipmentName} />
            </div>
            {!fromWarehouse && (
              <Field label="Ticket ID" value={form.sourceTicketNo} onChange={set('sourceTicketNo')} placeholder="The field service ticket" mono />
            )}
            <Field label="Contact number" type="tel" value={form.contactNumber} onChange={set('contactNumber')} placeholder="+91 …" />
          </div>

          <label className="block">
            <span className="label">Issue identified <Req /></span>
            <textarea className="input mt-1" rows={3} value={form.issue} onChange={set('issue')} maxLength={2000}
              placeholder="What is wrong with it, as found on site" />
          </label>

          {/* Photos, the video and the voice note, side by side. */}
          <div>
            <span className="label">Photos and recordings {!ots && <Req />}</span>
            <p className="mt-0.5 text-xs text-ink-500">One photo of the spare at least; a video and a voice note if they help.</p>
            <div className="mt-1.5">
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
            <label className="block"><span className="label">Courier</span><CourierSelect className="mt-1" value={form.inCourier} onChange={v => setForm(f => ({ ...f, inCourier: v }))} /></label>
            <Field label="Tracking / AWB number" value={form.inAwb} onChange={set('inAwb')} mono />
            <Field label="Date of dispatch" type="date" value={form.inDispatchedOn} onChange={set('inDispatchedOn')} />
          </div>
        </div>

        {/* What stops the ticket, said beside Raise ticket — not at the top of a long form (the user, 24 Oct). */}
        {error && <Alert key={nth} kind="error">{error}</Alert>}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {far && (
            <p className="w-full text-xs text-ink-500 sm:mr-auto sm:w-auto">
              {head?.head?.full_name ?? 'The project head'} approves it before you send it.
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
          labs={elsewhere}
          headName={head?.head?.full_name ?? 'the project head'}
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
function AskAnotherState({ labs, headName, initial, onClose, onChoose }: {
  labs: readonly Trc[]
  headName: string
  initial: { trcId: string; reason: string } | null
  onClose: () => void
  onChoose: (pick: { trcId: string; reason: string }) => void
}) {
  const [trcId, setTrcId] = useState(initial?.trcId ?? (labs.length === 1 ? labs[0].id : ''))
  const [reason, setReason] = useState(initial?.reason ?? '')
  const [error, setError, nth] = useError()

  const choose = () => {
    if (!trcId) { setError('Choose the Revive Lab.'); return }
    if (reason.trim().length < 5) { setError('Say why it should go there.'); return }
    onChoose({ trcId, reason: reason.trim() })
  }

  return (
    <Dialog title="Another state’s Revive Lab" icon={<IconChip icon={ShieldQuestion} tone="fuchsia" />} onClose={onClose}>
      <p className="text-sm text-ink-600">
        Another state&rsquo;s Revive Lab is approved first by {headName}, the project head. Raise the ticket now; once it
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
      {error && <Alert key={nth} kind="error">{error}</Alert>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={choose}>
          <ShieldQuestion className="h-4 w-4" /> Choose this Revive Lab
        </button>
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  )
}

/** Each choice in its own colour, chosen or not, so which is which reads at a glance. */
const SOURCE_LOOK: Record<TicketSource, { on: string; off: string; icon: string }> = {
  hospital: { on: 'border-sky-300 bg-sky-50 ring-1 ring-sky-300', off: 'border-ink-200 hover:border-sky-300 hover:bg-sky-50/50', icon: 'text-sky-600' },
  warehouse: { on: 'border-amber-300 bg-amber-50 ring-1 ring-amber-300', off: 'border-ink-200 hover:border-amber-300 hover:bg-amber-50/50', icon: 'text-amber-600' },
}

/** Under Pvt: which contract the equipment is under (rl_0024). */
const CONTRACT_CHOICES: ReadonlyArray<ChoiceOption<ContractType>> = [
  { value: 'AMC', label: 'AMC', hint: 'Annual maintenance contract', tone: 'teal' },
  { value: 'CAMC', label: 'CAMC', hint: 'Comprehensive — always critical', tone: 'fuchsia' },
  { value: 'OTS', label: 'OTS / Stock', hint: 'One-time service, or stock', tone: 'amber' },
]

function Req() {
  return <span className="text-cyrixRed-600">*</span>
}

function Field({
  label, value, onChange, placeholder, type = 'text', required, mono, maxLength,
}: {
  label: string
  value: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  placeholder?: string
  type?: string
  required?: boolean
  mono?: boolean
  maxLength?: number
}) {
  return (
    <label className="block">
      <span className="label">{label}{required && <> <Req /></>}</span>
      <input className={clsx('input mt-1', mono && 'font-mono')} type={type} value={value} onChange={onChange}
        placeholder={placeholder} maxLength={maxLength} />
    </label>
  )
}
