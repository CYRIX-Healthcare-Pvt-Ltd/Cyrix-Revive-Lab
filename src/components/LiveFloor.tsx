/**
 * Live floor — one Revive Lab as a small 3D building: its people in their
 * role's uniform at their own places, and every open ticket where its
 * status says it is (the user, 8 Oct: "eng raised tickets to trc in cyrix
 * truck, coordinator walking inside revive lab, coordinator assigning
 * engineer, engineer repairing, return vehicle").
 *
 * What arrives and what goes back are packed boxes; on an engineer's bench a
 * ticket is the spare itself, being worked on. Drawn from the same ticket
 * and member lists the rest of the app reads, so it can never say something
 * the Tickets page does not, and nobody sees a ticket they could not already
 * open. Light theme is day, dark theme is night. Loaded on its own, only
 * when somebody switches the dashboard to Animation.
 */
import { Suspense, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber'
import { ContactShadows, Environment, Html, Lightformer, OrbitControls, RoundedBox, Stars } from '@react-three/drei'
import { Bloom, EffectComposer, N8AO, SMAA, Vignette } from '@react-three/postprocessing'
import {
  CanvasTexture, Color, DoubleSide, ExtrudeGeometry, IcosahedronGeometry, LatheGeometry, MOUSE, Object3D, PlaneGeometry, RepeatWrapping,
  SRGBColorSpace, Shape, ShapeGeometry, TOUCH, Vector2,
  type Group, type InstancedMesh, type Mesh, type MeshStandardMaterial,
} from 'three'
import { useAuth } from '@/contexts/AuthContext'
import { useMembers, usePartRequests, type Member, type PartRequest, type Ticket, type Trc } from '@/lib/queries'
import { STATUS, itemsSummary, poLabel, waitingOnMe, type PartStatus, type TicketStatus } from '@/lib/tickets'
import { categoryTat } from '@/lib/tat'

/* ================================================================ roles */

type Role = 'admin' | 'manager' | 'coordinator' | 'purchase' | 'engineer'

/** One uniform per role (the user, 8 Oct: "each role person should have each uniform color"). */
export const UNIFORM: Record<Role, { label: string; color: string }> = {
  engineer:    { label: 'Revive Lab Engineer', color: '#2563EB' },
  coordinator: { label: 'Coordinator',         color: '#7C3AED' },
  manager:     { label: 'Manager',             color: '#15803D' },
  admin:       { label: 'Admin',               color: '#9F1239' },
  purchase:    { label: 'Purchase',            color: '#D97706' },
}

type Crew = Member & { is_observer?: boolean }

const rolesOf = (m: Crew): Role[] => [
  m.is_admin && 'admin', m.is_manager && 'manager', m.is_coordinator && 'coordinator',
  m.is_engineer && 'engineer', m.is_purchase && 'purchase',
].filter(Boolean) as Role[]

/**
 * Where a person works, and so which uniform they wear on the floor: their
 * highest role (the user, 8 Oct: "where is saranya? this is admin cabin" —
 * an admin who also coordinates sits in the admin cabin). The card on hover
 * lists every role they hold.
 */
const placeOfPerson = (m: Crew): Role | null => rolesOf(m)[0] ?? null

/* ================================================================ the plan */

type V3 = [number, number, number]

/**
 * In metres; x to the right, z towards the road. Rooms along the back wall,
 * the benches in rows in the middle with an aisle in front of each row, the
 * dock and dispatch along the front, and corridors round it all that people
 * walk along. Sized for eighteen benches at true size.
 */
const HALF_X = 16, HALF_Z = 9.5
const CABIN_FRONT = -5.4
const DESK_Z = -7.0
const ROOM = {
  coordinator: { x0: -15.7, x1: -8.7 },
  manager: { x0: -8.4, x1: -2.4 },
  admin: { x0: -2.2, x1: 3.8 },
  purchase: { x0: 4.0, x1: 10.3 },
  pantry: { x0: 10.5, x1: 15.7 },
}
const COORD_ROOM_FRONT = -3.6
const BACK_CORRIDOR = -4.75
const BENCH_AREA = { x0: -7.6, x1: 10.4, z0: -4.1, z1: 3.9 }
const FRONT_CORRIDOR = 4.6
const LEFT_AISLE = -8.2
const RIGHT_AISLE = 11.3

const SPOT = {
  dock: [-12.2, 0, 7.1] as V3,
  dispatch: [12.2, 0, 7.1] as V3,
  shelf: [14.6, 0, -0.6] as V3,
  rack: [-14.9, 0, -4.5] as V3,
}
const ROAD_Z = 16
/** Where a truck stands at its dock, off the road. */
const APRON_Z = 11.4

/** Desks side by side in a room, one per person; the people face the room's glass, towards whoever is looking. */
function deskSeats(room: { x0: number; x1: number }, n: number): V3[] {
  const w = room.x1 - room.x0
  const per = Math.max(1, Math.min(n, Math.floor((w - 0.6) / 1.9)))
  return Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / per), col = i % per
    const inRow = Math.min(per, n - row * per)
    const span = inRow * 1.9
    return [room.x0 + (w - span) / 2 + col * 1.9 + 0.95, 0, DESK_Z + row * 1.4] as V3
  })
}

/**
 * One bench per engineer: up to three rows, as many across as it takes, and
 * an aisle in front of every row to walk along. Benches and people stay their
 * real size unless a Revive Lab has more engineers than the floor holds.
 */
const CELL_W = 3.0, CELL_D = 2.65
function benchLayout(n: number) {
  const rows = Math.max(1, Math.min(3, Math.ceil(n / 6)))
  const cols = Math.max(1, Math.ceil(n / rows))
  const w = BENCH_AREA.x1 - BENCH_AREA.x0, d = BENCH_AREA.z1 - BENCH_AREA.z0
  const cw = w / cols, cd = d / rows
  const scale = Math.min(1, cw / CELL_W, cd / CELL_D)
  const at = (i: number): V3 => {
    const row = Math.floor(i / cols), col = i % cols
    return [BENCH_AREA.x0 + cw * (col + 0.5), 0, BENCH_AREA.z0 + cd * row + 1.25 * scale]
  }
  /** The aisle in front of a bench's row, where somebody stands to talk to its engineer. */
  const aisle = (i: number) => at(i)[2] + 1.05 * scale
  return { at, aisle, scale }
}

type Place = 'dock' | 'desk' | 'bench' | 'dispatch' | 'outbound'

function placeOf(s: TicketStatus): Place | null {
  switch (s) {
    case 'pending_acceptance': case 'transferred': return 'dock'
    case 'accepted': case 'awaiting_approval': case 'approved': return 'desk'
    case 'assigned': case 'in_repair': case 'parts_requested': case 'parts_ordered': case 'parts_ready': return 'bench'
    case 'repaired': case 'not_repairable': case 'service_denied': return 'dispatch'
    case 'in_transit_return': return 'outbound'
    default: return null
  }
}

/* ================================================================ small helpers */

type Hover =
  | { kind: 'person'; at: V3; crew: Crew; roles: Role[]; load: string }
  | { kind: 'box'; at: V3; t: Ticket; late: boolean; mine: boolean }

/**
 * Answers (the user, 8 Oct: "these pop ups are coming randomly, not good,
 * better say it when they interact"). When somebody stops to talk to a person,
 * that person's answer is put here, and their bubble shows it in turn.
 */
type Line = { say: string; from: number; until: number }
const Talk = createContext<React.MutableRefObject<Map<string, Line>> | null>(null)

/**
 * Where everybody is standing or walking (the user, 8 Oct: "peoples are also
 * overlapping like ghosts"). Those on the move step round those in the way and
 * wait for one coming straight at them.
 */
type Spot = { x: number; z: number; moving: boolean }
const Crowd = createContext<React.MutableRefObject<Map<string, Spot>> | null>(null)

/** Somebody who stays put — at a bench or a desk — so walkers go round them. */
function useStand(id: string, x: number, z: number) {
  const crowd = useContext(Crowd)
  useEffect(() => {
    crowd?.current.set(id, { x, z, moving: false })
    return () => { crowd?.current.delete(id) }
  }, [crowd, id, x, z])
}

/** The bubble over somebody's head: what they say on a stop, or their answer when spoken to. */
function useAnswer(id: string) {
  const talk = useContext(Talk)
  return (now: number): string => {
    const l = talk?.current.get(id)
    return l && now >= l.from && now < l.until ? l.say : ''
  }
}

/** The app's dark theme is night on the floor, the light theme day (the user, 8 Oct). */
const Night = createContext(false)
const useNight = () => useContext(Night)

function useDarkTheme(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const root = document.documentElement
    const watch = new MutationObserver(() => setDark(root.classList.contains('dark')))
    watch.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => watch.disconnect()
  }, [])
  return dark
}

/** 0 → 1, easing in and out: a start and a stop rather than a jolt. */
const smooth = (x: number) => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t) }

/** A number 0–1 from an id, so everybody keeps their own rhythm and every spare its own look. */
const seedOf = (id: string) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return (h % 1000) / 1000 }

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const pointer = {
  over: (cb: () => void) => (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); document.body.style.cursor = 'pointer'; cb() },
  out: (cb: () => void) => () => { document.body.style.cursor = ''; cb() },
}

/* ================================================================ view */

export default function LiveFloor({ tickets, trcs }: { tickets: Ticket[]; trcs: Trc[] }) {
  const { me } = useAuth()
  const { data: members } = useMembers(true)
  const { data: requests } = usePartRequests()

  // Their own Revive Lab first; otherwise the one with most going on.
  const labs = useMemo(() => trcs.filter(t => t.is_active), [trcs])
  const busiest = useMemo(() => {
    const n = new Map<string, number>()
    for (const t of tickets) if (placeOf(t.status)) n.set(t.trc_id, (n.get(t.trc_id) ?? 0) + 1)
    return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
  }, [tickets])
  const [labId, setLabId] = useState<string>('')
  const night = useDarkTheme()
  const pad = useRef<Pad>({ held: new Set(), reset: false })
  const lab = labs.find(l => l.id === labId)
    ?? labs.find(l => me?.trc_ids.includes(l.id))
    ?? labs.find(l => l.id === busiest)
    ?? labs.find(l => /cochin/i.test(l.name))
    ?? labs[0]

  // Revive Lab staff only (the user, 8 Oct: "trc observer not needed").
  const crew = useMemo(
    () => ((members ?? []) as Crew[]).filter(m => lab && m.trc_ids.includes(lab.id) && placeOfPerson(m)),
    [members, lab],
  )
  const here = useMemo(() => tickets.filter(t => lab && t.trc_id === lab.id && placeOf(t.status)), [tickets, lab])

  // Pause drawing while the tab is not looked at.
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])

  if (!lab) return null

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className="input !w-auto !py-1.5" value={lab.id} onChange={e => setLabId(e.target.value)} aria-label="Revive Lab">
          {labs.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-600">
          {(Object.keys(UNIFORM) as Role[]).map(r => (
            <span key={r} className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: UNIFORM[r].color }} /> {UNIFORM[r].label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#DC2626]" /> Past its TAT</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[#FACC15]" /> Waiting on you</span>
        </div>
      </div>
      <div className="card relative h-[min(74vh,680px)] min-h-[400px] overflow-hidden !p-0">
        <Canvas
          shadows
          dpr={[1, 1.5]}
          frameloop={visible ? 'always' : 'never'}
          camera={{ position: [20, 21, 27], fov: 40 }}
          gl={{ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' }}
        >
          <Night.Provider value={night}>
            <Suspense fallback={null}>
              <Scene lab={lab} crew={crew} tickets={here} requests={requests ?? []} pad={pad} />
            </Suspense>
          </Night.Provider>
        </Canvas>
      </div>
    </div>
  )
}

/* ================================================================ scene */

function Scene({ lab, crew, tickets, requests, pad }: { lab: Trc; crew: Crew[]; tickets: Ticket[]; requests: PartRequest[]; pad: React.MutableRefObject<Pad> }) {
  const { me } = useAuth()
  const navigate = useNavigate()
  const [hover, setHover] = useState<Hover | null>(null)
  const still = reducedMotion()
  const night = useNight()
  const road = useRef<Record<string, Obstacle>>({})
  const talk = useRef(new Map<string, Line>())
  const crowd = useRef(new Map<string, Spot>())
  const seated = useRef(new Set<string>())
  const inDock = useRef({ parked: false, soon: false })
  const outDock = useRef({ parked: false, soon: false })

  const by = (r: Role) => crew.filter(m => placeOfPerson(m) === r)
  /** "Saranya", from "Saranya K S"; "Tincy", from "TINCY K MARIAM". */
  const firstName = (id: string | undefined | null) => {
    const w = (crew.find(m => m.employee_id === id)?.full_name ?? '').split(/[\s-]+/)[0] ?? ''
    return w ? w[0].toUpperCase() + w.slice(1).toLowerCase() : ''
  }
  const names = new Map(crew.map(m => [m.employee_id, firstName(m.employee_id)]))
  /** Loaders are not on the staff list; Kerala calls an older man "chetta", elsewhere "bhai". */
  const mate = lab.state === 'Kerala' ? 'Chetta' : 'Bhai'
  const engineers = by('engineer'), coordinators = by('coordinator'), managers = by('manager')
  const admins = by('admin'), buyers = by('purchase')

  const atBench = [...engineers, ...crew.filter(m => m.is_engineer && placeOfPerson(m) !== 'engineer' && placeOfPerson(m) !== 'coordinator')]
  const benches = benchLayout(atBench.length)
  const bs = benches.scale
  const benchIndex = new Map(atBench.map((m, i) => [m.employee_id, i]))
  /** A bench of their own, for somebody whose highest role sits in a cabin. */
  const benchTrip = (m: Crew) => {
    const i = benchIndex.get(m.employee_id)
    if (i === undefined || !m.is_engineer) return undefined
    const b = benches.at(i)
    return { home: [b[0], 0, b[2] - 0.85 * bs] as V3, behindZ: b[2] - 1.35 * bs }
  }

  const at = (place: Place) => tickets.filter(t => placeOf(t.status) === place)
  const dock = at('dock'), desk = at('desk'), dispatch = at('dispatch'), outbound = at('outbound')
  const onBench = at('bench')
  const lateOnBench = onBench.filter(t => categoryTat(t)?.exceeded)

  const seats = {
    coordinator: deskSeats(ROOM.coordinator, Math.max(1, coordinators.length)),
    manager: deskSeats(ROOM.manager, Math.max(1, managers.length)),
    admin: deskSeats(ROOM.admin, Math.max(1, admins.length)),
    purchase: deskSeats(ROOM.purchase, Math.max(1, buyers.length)),
  }

  // The coordinators share the errands (the user, 8 Oct: "why other coordinator ie jeevan not walking?").
  // Components: one bought or ready goes from the shelf to its engineer; one waiting on Purchase means a word in their cabin.
  const partsFor = onBench.find(t => (t.status === 'parts_ready' || (t.parts ?? []).some(r => r.status === 'bought' || r.status === 'sent')) && benchIndex.has(t.engineer_id ?? ''))
  // Pending with Purchase, each where it stands (the user, 9 Oct: "if any purchase pending, coordinator should go to
  // purchase dept and ask logical questions"): from the requests themselves, else from each ticket's own list of them.
  const lateIds = new Set(lateOnBench.map(t => t.id))
  const mineToBuy = requests.filter(r => r.trc_id === lab.id && r.route === 'purchase'
    && (r.status === 'requested' || r.status === 'forwarded' || r.status === 'accepted' || (r.status === 'bought' && !!r.po_number)))
  const purchaseItems: PurchaseItem[] = mineToBuy.length
    ? mineToBuy.map(r => ({ code: r.ticket_code ?? r.code ?? '', part: r.name, status: r.status, po: r.po_number, edd: r.edd, vendor: r.vendor, since: r.requested_at, late: !!r.ticket_id && lateIds.has(r.ticket_id) }))
    : onBench.flatMap(t => (t.parts ?? [])
      .filter(r => r.route === 'purchase' && (r.status === 'requested' || r.status === 'forwarded' || r.status === 'accepted'))
      .map(r => ({ code: t.code, part: '', status: r.status, late: lateIds.has(t.id) })))
  const partsTo = partsFor ? { x: benches.at(benchIndex.get(partsFor.engineer_id!)!)[0], z: benches.aisle(benchIndex.get(partsFor.engineer_id!)!), code: partsFor.code, who: partsFor.engineer_id!, name: firstName(partsFor.engineer_id), answer: `Thanks ${firstName(coordinators[0]?.employee_id) || 'a lot'}! Back on it` } : null
  const errands = ([
    dock.length > 0 && 'dock',
    desk.length > 0 && engineers.length > 0 && 'assign',
    partsTo && 'parts',
    purchaseItems.length > 0 && buyers.length > 0 && 'purchase',
    dispatch.length > 0 && 'dispatch',
  ].filter(Boolean) as Errand[])
  const errandsOf = (i: number) => coordinators.length ? errands.filter((_, k) => k % coordinators.length === i) : []

  /*
    The workflow, turned into who walks where (the user, 8 Oct: "use our work
    flow logic and turn to animation"). Every trip is a real ticket:
    - the admin checks on spares past their TAT, then the coordinator's queue;
    - a manager goes to an engineer whose "not repairable" waits on approval;
    - an engineer whose repair is done takes the spare to the coordinator;
    - an engineer whose parts are ready fetches them from the shelf;
    - Purchase brings ordered parts to the shelf;
    - the coordinator gives a spare to assign to the engineer with least on the bench.
  */
  const benchVisit = (t: Ticket) => {
    const i = benchIndex.get(t.engineer_id ?? '')
    return i === undefined ? null : { x: benches.at(i)[0], z: benches.aisle(i), code: t.code, who: t.engineer_id! }
  }
  /** The engineer's side of it, from the ticket as it stands. */
  /** The engineer's side of it, from the ticket as it stands — one of a few true-sounding answers, the same one for the same ticket. */
  const excuse = (t: Ticket) => {
    const boss = firstName(admins[0]?.employee_id) || "ma'am"
    const pick = (lines: string[]) => lines[Math.floor(seedOf(t.id) * lines.length)]
    if ((t.parts ?? []).some(r => r.status !== 'received' && r.status !== 'declined' && r.status !== 'cancelled')) {
      return pick([`Waiting on parts for ${t.code}, ${boss}`, `It's with Purchase — they're ordering`, `Parts are on the way for ${t.code}`])
    }
    if (t.status === 'parts_ready') return pick(['Parts just came — finishing it now', 'Fitting the new part now'])
    return pick([
      `Finishing it today, sorry ${boss}`, 'Found the fault — fixing it now', 'Just soldering the last joint',
      'Calibration left — done by evening', 'Testing it now, one hour more', `Tricky one, ${boss} — by 5 o'clock`,
    ])
  }
  const firstPer = (list: Ticket[], max: number) => {
    const seen = new Set<string>(), out: Ticket[] = []
    for (const t of list) {
      if (!t.engineer_id || seen.has(t.engineer_id) || !benchIndex.has(t.engineer_id)) continue
      seen.add(t.engineer_id); out.push(t)
      if (out.length >= max) break
    }
    return out
  }
  const adminVisits = firstPer(lateOnBench, 3).map(t => { const v = benchVisit(t); return v && { ...v, name: firstName(t.engineer_id), answer: excuse(t) } }).filter(Boolean) as Visit[]
  const nrWaiting = firstPer(dispatch.filter(t => t.status === 'not_repairable' && !t.nr_approved_at), 2)
    .map(t => { const v = benchVisit(t); return v && { ...v, name: firstName(t.engineer_id), answer: `Tried everything, ${firstName(managers[0]?.employee_id) || 'sir'} — it's beyond repair` } }).filter(Boolean) as Visit[]
  const handovers = new Map(firstPer(dispatch.filter(t => t.status === 'repaired' || t.status === 'service_denied'), 4).map(t => [t.engineer_id!, t.code]))
  const partsReady = new Map<string, string>()
  const partsComing = onBench.some(t => t.status === 'parts_ordered')
  /** The buyer the coordinator goes to: one at their desk, while the first is off with parts that came in. */
  const deskBuyer = buyers.length > 1 && partsComing ? 1 : 0
  const lightest = engineers.length
    ? engineers.map(m => ({ i: benchIndex.get(m.employee_id)!, n: onBench.filter(t => t.engineer_id === m.employee_id).length })).sort((a, b) => a.n - b.n || a.i - b.i)[0].i
    : -1
  const assignTo = lightest >= 0 && desk[0] ? { x: benches.at(lightest)[0], z: benches.aisle(lightest), code: desk[0].code, who: atBench[lightest].employee_id, name: firstName(atBench[lightest].employee_id), answer: `Got it, ${firstName(coordinators[0]?.employee_id) || 'boss'} — starting now` } : null
  const pending = dock.length + desk.length + dispatch.length
  const coordName = firstName(coordinators[0]?.employee_id)
  /** The admin's questions at the coordinator's desk, and the coordinator's answers from the floor as it is. */
  const adminAsks = (me: string): Array<[string, string]> => [
    [`${coordName ? 'Hey ' + coordName + ', ' : ''}${pending ? pending + ' pending — let\'s clear them' : 'all clear today?'}`,
      pending ? `${dock.length} at the dock, ${desk.length} to assign — by evening, ${me}` : `All clear, ${me}!`],
    ['When will the dispatch go?', dispatch.length ? `${dispatch.length} packed — going today` : `Nothing to send yet, ${me}`],
    ...(lateOnBench.length ? [[`${lateOnBench.length} past TAT — push them, please`, 'Yes, I\'ll follow up with the team']] as Array<[string, string]> : []),
  ]
  /** The manager's questions: the dock, the next dispatch, parts with Purchase. */
  const managerAsks = (me: string): Array<[string, string]> => [
    [`${coordName ? coordName + ', ' : ''}how's the dock today?`, `${dock.length} came in, ${desk.length} to assign`],
    ['When\'s the next dispatch?', dispatch.length ? `${dispatch.length} ready — today itself, ${me}` : 'Nothing ready yet'],
    ['Any parts stuck with Purchase?', purchaseItems.length ? `${purchaseItems.length} with them — I'm following up` : 'No, all clear'],
  ]
  const workOf = (id: string) => {
    const mine = onBench.filter(t => t.engineer_id === id)
    const late = mine.filter(t => categoryTat(t)?.exceeded)
    const waitingParts = mine.find(t => t.status === 'parts_requested' || t.status === 'parts_ordered')
    return { n: mine.length, late: late.length, first: mine[0]?.code, lateCode: late[0]?.code, parts: waitingParts?.code }
  }

  /*
    Engineers with nothing on the bench (the user, 9 Oct: "what we do when we are free ... humanise more"):
    one each to chat with the two loaders, two on a phone call outside, and the rest to the pantry, four chairs at most.
    They stay at it until a spare is assigned to them.
  */
  const idle = engineers.filter(m => !onBench.some(t => t.engineer_id === m.employee_id) && !handovers.has(m.employee_id) && !partsReady.has(m.employee_id))
  type Free = 'pantry' | 'loader-in' | 'call-right' | 'loader-out' | 'call-left' | 'help' | 'tidy' | 'count'
  const freeTime = new Map<string, { kind: Exclude<Free, 'pantry'> } | { kind: 'pantry'; chair: { at: V3; face: number; via: V3[] } }>()
  const plan: Free[] = ['pantry', 'loader-in', 'help', 'call-right', 'tidy', 'pantry', 'loader-out', 'count', 'call-left', 'pantry', 'help', 'pantry']
  let chairsUsed = 0
  idle.forEach((m, k) => {
    const want = plan[k] ?? 'pantry'
    if (want !== 'pantry') { freeTime.set(m.employee_id, { kind: want }); return }
    if (chairsUsed < PANTRY_CHAIRS.length) freeTime.set(m.employee_id, { kind: 'pantry', chair: PANTRY_CHAIRS[chairsUsed++] })
  })
  const busiestBench = engineers
    .map(m => ({ m, n: onBench.filter(t => t.engineer_id === m.employee_id).length, late: lateOnBench.find(t => t.engineer_id === m.employee_id) }))
    .filter(x => x.n > 0)
    .sort((a, b) => Number(!!b.late) - Number(!!a.late) || b.n - a.n)[0]
  const helpAt = busiestBench ? {
    x: benches.at(benchIndex.get(busiestBench.m.employee_id)!)[0], z: benches.aisle(benchIndex.get(busiestBench.m.employee_id)!),
    who: busiestBench.m.employee_id, late: !!busiestBench.late,
    code: (busiestBench.late ?? onBench.find(t => t.engineer_id === busiestBench.m.employee_id))!.code,
  } : null
  const pantryChair = new Map<string, { at: V3; face: number; via: V3[] }>()
  freeTime.forEach((v, id) => { if (v.kind === 'pantry') pantryChair.set(id, v.chair) })
  // Two pairs at most, from those not already on an errand; each pair keeps the same time, so they meet at the cooler.
  const free = engineers.map((m, i) => ({ m, i })).filter(({ m }) => !handovers.has(m.employee_id) && !partsReady.has(m.employee_id) && !freeTime.has(m.employee_id))
  const waterOf = new Map<string, { slot: 0 | 1; pair: number; partner: string }>()
  const chatOf = new Map<string, [string, string, string]>()
  ;[[1, 2], [7, 8]].forEach(([a, b], pair) => {
    if (!free[a] || !free[b]) return
    waterOf.set(free[a].m.employee_id, { slot: 0, pair, partner: free[b].m.employee_id }); waterOf.set(free[b].m.employee_id, { slot: 1, pair, partner: free[a].m.employee_id })
    // A question, an answer from the other one's real bench, and a reply from this one's.
    const one = workOf(free[a].m.employee_id), two = workOf(free[b].m.employee_id)
    const n1 = firstName(free[a].m.employee_id), n2 = firstName(free[b].m.employee_id)
    const answer = two.n === 0 ? `None, ${n1}! All clear on mine`
      : two.late ? `${two.n} — ${two.late} past TAT, rushing` : `${two.n}, all on time`
    const reply = one.n === 0 ? 'Mine is clear — I\'ll help you'
      : one.late ? `I've ${one.n}, ${one.lateCode} is late too` : `I've ${one.n}. Done by evening`
    const q = pair % 2 ? `${n2}, busy today? How many pending?` : `Hey ${n2}, how many on your bench?`
    chatOf.set(free[a].m.employee_id, [q, answer, reply])
    chatOf.set(free[b].m.employee_id, ['', '', ''])
  })

  const ticketHover = (t: Ticket, p: V3) => {
    const late = !!categoryTat(t)?.exceeded
    const mine = waitingOnMe(t, me)
    return {
      late, mine,
      onHover: (on: boolean) => setHover(on ? { kind: 'box', at: p, t, late, mine } : null),
      onOpen: () => navigate(`/tickets/${t.code}`),
    }
  }
  const parcel = (t: Ticket, p: V3, key: string) => <Parcel key={key} at={p} {...ticketHover(t, p)} />
  const pile = (list: Ticket[], origin: V3, prefix: string) => [
    ...list.slice(0, 36).map((t, i) => parcel(t, [origin[0] + (i % 3) * 0.72 - 0.72, 0.36 + Math.floor(i / 9) * 0.52, origin[2] + (Math.floor(i / 3) % 3) * 0.72 - 0.72], `${prefix}${t.id}`)),
    list.length > 36 && <Label key={`${prefix}more`} at={[origin[0], 2.7, origin[2]]} text={`+${list.length - 36} more`} />,
  ]

  const loadOf = (m: Crew) => {
    const n = onBench.filter(t => t.engineer_id === m.employee_id).length
    const late = lateOnBench.filter(t => t.engineer_id === m.employee_id).length
    switch (placeOfPerson(m)) {
      case 'engineer': return `${n} spare${n === 1 ? '' : 's'} on the bench${late ? ` · ${late} past TAT` : ''}`
      case 'coordinator': return `${dock.length} at the dock · ${desk.length} to assign · ${dispatch.length} to send back`
      case 'admin': return lateOnBench.length ? `${lateOnBench.length} spare${lateOnBench.length === 1 ? '' : 's'} past TAT on the floor` : ''
      default: return ''
    }
  }
  const personHover = (m: Crew) => (on: boolean, p: V3) =>
    setHover(on ? { kind: 'person', at: p, crew: m, roles: rolesOf(m), load: loadOf(m) } : null)

  return (
    <>
      <Talk.Provider value={talk}>
      <Crowd.Provider value={crowd}>
      <Seated.Provider value={seated}>
      <Names.Provider value={names}>
      <Pantry />
      <Sky />
      <directionalLight
        position={night ? [-18, 26, 10] : [18, 26, 12]}
        intensity={night ? 0.45 : 1.65}
        color={night ? '#A9BCFF' : '#FFF6E5'}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-camera-left={-30}
        shadow-camera-right={30}
        shadow-camera-top={30}
        shadow-camera-bottom={-30}
      />
      <Roam pad={pad} />
      {night && <Lamps />}
      <StreetLights />

      <Ground />
      <Building name={lab.name} />

      {/* Rooms: a desk and chair per person, a board over each */}
      {(['coordinator', 'manager', 'admin', 'purchase'] as const).map(r => (
        <group key={r}>
          {seats[r].map((s, i) => <Workstation key={i} at={s} />)}
          <Board at={[(ROOM[r].x0 + ROOM[r].x1) / 2, 2.55, r === 'coordinator' ? COORD_ROOM_FRONT : CABIN_FRONT]} text={r === 'coordinator' ? 'Coordinator' : UNIFORM[r].label} color={UNIFORM[r].color} />
        </group>
      ))}
      <Shelf at={SPOT.shelf} />
      <Zone at={SPOT.dock} size={[3.4, 3.2]} color="#F6D9A8" label="Arrival dock" />
      <Zone at={SPOT.dispatch} size={[3.4, 3.2]} color="#BFE3C6" label="Ready to send back" />
      <Zone at={SPOT.rack} size={[1.6, 2.4]} color="#E9D5FF" label="To assign" />
      {atBench.map((m, i) => <Bench key={m.employee_id} at={benches.at(i)} scale={bs} />)}

      {/* People */}
      {engineers.map((m, i) => {
        const b = benches.at(i)
        const home: V3 = [b[0], 0, b[2] - 0.85 * bs]
        const busy = onBench.some(t => t.engineer_id === m.employee_id)
        const handover = handovers.get(m.employee_id)
        const parts = partsReady.get(m.employee_id)
        const water = waterOf.get(m.employee_id)
        const k = idle.indexOf(m)
        // Nothing on the bench: free time, until a spare is assigned (the user, 9 Oct).
        if (k >= 0) {
          const behindZ = b[2] - 1.35 * bs
          const round: FreeKind[] = ['pantry', 'ask', 'loader-in', 'tidy', 'call-right', 'pantry', 'help', 'loader-out', 'ask', 'count', 'pantry', 'call-left']
          const order = round.map((_, n) => round[(n + k * 3) % round.length]).filter(x => (x !== 'help' || helpAt) && (x !== 'ask' || coordinators.length > 0))
          return <Walker key={m.employee_id} color={UNIFORM.engineer.color} seed={m.employee_id} scale={bs} tool="meter"
            stops={freeDay(home, behindZ, order, i, {
              chair: PANTRY_CHAIRS[k % PANTRY_CHAIRS.length],
              loaderLines: { in: loaderTalk(true, dock.length, mate, firstName(m.employee_id)), out: loaderTalk(false, dispatch.length + outbound.length, mate, firstName(m.employee_id)) },
              help: helpAt && { ...helpAt, name: firstName(helpAt.who) },
              me: firstName(m.employee_id),
              ask: coordinators[0] ? { seat: seats.coordinator[0], who: coordinators[0].employee_id, name: firstName(coordinators[0].employee_id), answer: desk.length ? `Yes ${firstName(m.employee_id)} — ${desk[0].code}, I'll bring it` : `Nothing yet, ${firstName(m.employee_id)} — I'll call you` } : null,
            })}
            still={still} onHover={personHover(m)} />
        }
        const free = freeTime.get(m.employee_id)
        if (free) {
          const behindZ = b[2] - 1.35 * bs
          const kind = free.kind === 'help' && !helpAt ? 'tidy' : free.kind
          const stops = free.kind === 'pantry' ? pantryRound(home, behindZ, free.chair, i)
            : kind === 'loader-in' ? loaderRound(home, behindZ, 'loader-in', SPOT.dock[0], loaderTalk(true, dock.length), i)
            : kind === 'loader-out' ? loaderRound(home, behindZ, 'loader-out', SPOT.dispatch[0], loaderTalk(false, dispatch.length + outbound.length), i)
            : kind === 'help' ? helpRound(home, behindZ, helpAt!, i)
            : kind === 'tidy' ? tidyRound(home, i)
            : kind === 'count' ? countRound(home, behindZ, i)
            : callRound(home, behindZ, kind === 'call-right', i)
          // Walk there once; then keep at it there.
          const settle = free.kind === 'pantry' ? stops.length - 1
            : kind.startsWith('loader') ? 6 : kind === 'help' ? 5 : kind === 'tidy' ? 1 : kind === 'count' ? 5 : 8
          return <Walker key={m.employee_id} color={UNIFORM.engineer.color} seed={m.employee_id} scale={bs}
            tool={kind === 'count' ? 'meter' : null} stops={stops} loopFrom={settle} still={still} onHover={personHover(m)} />
        }
        // Somewhere to go: a round from the bench and back; otherwise at the bench all along.
        return handover || parts || water
          ? <Walker key={m.employee_id} color={UNIFORM.engineer.color} seed={m.employee_id} scale={bs} tool={busy ? 'iron' : null}
              offset={water ? 4 + water.pair * 9 : undefined}
              stops={engineerRound(home, b[2] - 1.35 * bs, seats.coordinator[0], handover ?? null, parts ?? null, i, water, chatOf.get(m.employee_id))}
              still={still} onHover={personHover(m)} />
          : <Engineer key={m.employee_id} at={home} scale={bs} seed={m.employee_id} neighbour={i % 2 ? -1 : 1}
              working={busy && !still} onHover={personHover(m)} />
      })}
      {coordinators.map((m, i) => {
        const mine = errandsOf(i)
        return mine.length
          ? <Walker key={m.employee_id} color={UNIFORM.coordinator.color} seed={m.employee_id}
              stops={coordinatorRound(seats.coordinator[i], mine, assignTo, i, partsTo, buyers[deskBuyer] ? {
                seat: seats.purchase[deskBuyer], who: buyers[deskBuyer].employee_id,
                lines: purchaseTalk(purchaseItems, firstName(buyers[deskBuyer].employee_id), firstName(m.employee_id)),
              } : null)}
              still={still} onHover={personHover(m)} />
          : <Sitter key={m.employee_id} at={seats.coordinator[i]} color={UNIFORM.coordinator.color} seed={m.employee_id} still={still} onHover={personHover(m)} />
      })}
      {managers.map((m, i) => {
        const visits = i === 0 ? nrWaiting.map(v => ({ ...v, say: `${v.name ? v.name + ', ' : ''}${v.code} — really not repairable? Show me` })) : []
        const bench = benchTrip(m)
        const talk = i === 0 && coordinators[0] ? { seat: seats.coordinator[0], who: coordinators[0].employee_id, lines: managerAsks(firstName(m.employee_id)) } : undefined
        return visits.length || bench || talk
          ? <Walker key={m.employee_id} color={UNIFORM.manager.color} seed={m.employee_id}
              tool={bench && onBench.some(t => t.engineer_id === m.employee_id) ? 'iron' : null}
              stops={cabinRound('manager', seats.manager[i], visits, 30, talk, bench)}
              still={still} onHover={personHover(m)} />
          : <Sitter key={m.employee_id} at={seats.manager[i]} color={UNIFORM.manager.color} seed={m.employee_id} still={still} onHover={personHover(m)} />
      })}
      {/* Every admin walks the floor now and then, one after the other (the user, 8 Oct: "saranya ... should be in the floor"). */}
      {admins.map((m, i) => (
        <Walker key={m.employee_id} color={UNIFORM.admin.color} seed={m.employee_id}
          tool={benchTrip(m) && onBench.some(t => t.engineer_id === m.employee_id) ? 'iron' : null}
          stops={cabinRound('admin', seats.admin[i], adminVisits.map(v => ({ ...v, say: `${v.name ? v.name + ', ' : ''}${v.code} is past TAT — what's holding it?` })), 14 + i * 22,
            { seat: seats.coordinator[0], who: coordinators[0]?.employee_id, lines: coordinators[0] ? adminAsks(firstName(m.employee_id)) : [] }, benchTrip(m))}
          still={still} onHover={personHover(m)} />
      ))}
      {buyers.map((m, i) => i === 0 && partsComing
        ? <Walker key={m.employee_id} color={UNIFORM.purchase.color} seed={m.employee_id}
            stops={purchaseRound(seats.purchase[i])} still={still} onHover={personHover(m)} />
        : <Sitter key={m.employee_id} at={seats.purchase[i]} color={UNIFORM.purchase.color} seed={m.employee_id} still={still} onHover={personHover(m)} />)}

      {/* Tickets: packed where they travel, the spare itself on a bench */}
      {pile(dock, SPOT.dock, 'd')}
      {desk.slice(0, 12).map((t, i) => parcel(t, [SPOT.rack[0] + (i % 2) * 0.66 - 0.33, 0.36 + Math.floor(i / 6) * 0.52, SPOT.rack[2] + (Math.floor(i / 2) % 3) * 0.66 - 0.66], `k${t.id}`))}
      {onBench.map(t => {
        const i = benchIndex.get(t.engineer_id ?? '')
        if (i === undefined) return parcel(t, [SPOT.rack[0], 0.36, SPOT.rack[2] + 1.1], `b${t.id}`)
        const b = benches.at(i)
        const n = onBench.filter(x => x.engineer_id === t.engineer_id).indexOf(t)
        // The one being worked on in front of the engineer; the rest waiting at the bench's end.
        const p: V3 = n === 0
          ? [b[0], 0.98 * bs, b[2] - 0.12 * bs]
          : [b[0] + (-1.0 + ((n - 1) % 2) * 0.3) * bs, (0.98 + Math.floor((n - 1) / 2) * 0.12) * bs, b[2] + (0.15 - ((n - 1) % 2) * 0.05) * bs]
        return <Spare key={`b${t.id}`} at={p} scale={bs} kind={Math.floor(seedOf(t.id) * SPARES)} {...ticketHover(t, p)} />
      })}
      {pile(dispatch, SPOT.dispatch, 'x')}

      {/* Trucks: one arrives while anything is on its way in, one leaves with what is going back. */}
      <Road.Provider value={road}>
        <Truck id="in" stop={SPOT.dock[0]} body="#D62F35" label="CYRIX" active={dock.length > 0 && !still} dock={inDock} first={1} gap={[140, 190]} lead={45} />
        <Truck id="out" stop={SPOT.dispatch[0]} body="#F5F5F4" label="RETURN" active={(dispatch.length > 0 || outbound.length > 0) && !still} dock={outDock} first={25} gap={[150, 210]} lead={30} />
        <Outside />
      </Road.Provider>
      {/* Loaders in hi-vis: boxes off the Cyrix truck to the dock, and from dispatch onto the return truck */}
      <Walker color="#F97316" seed="loader-in" gate={inDock} rest={loaderBreak('in', mate)} still={still} onHover={() => {}} vest stops={[
        { at: [SPOT.dock[0] - 2.2, 0, 8.9], wait: 0.6, face: -Math.PI / 2 },
        { at: [SPOT.dock[0] - 2.6, 0, 9.9] },
        { at: [SPOT.dock[0] - 3.35, 0, APRON_Z], wait: 1.8, face: Math.PI / 2, pick: 'high' },
        { at: [SPOT.dock[0] - 2.6, 0, 9.9], carry: true },
        { at: [SPOT.dock[0] - 1.5, 0, 8.5], wait: 1.8, face: Math.PI * 0.85, put: 'low', carry: true },
      ]} />
      <Walker color="#F97316" seed="loader-out" gate={outDock} rest={loaderBreak('out', mate)} still={still} onHover={() => {}} vest stops={[
        { at: [SPOT.dispatch[0] - 2.2, 0, 8.9], wait: 0.6, face: -Math.PI / 2 },
        { at: [SPOT.dispatch[0] - 1.5, 0, 8.5], wait: 1.8, face: Math.PI * 0.85, pick: 'low' },
        { at: [SPOT.dispatch[0] - 2.6, 0, 9.9], carry: true },
        { at: [SPOT.dispatch[0] - 3.35, 0, APRON_Z], wait: 1.8, face: Math.PI / 2, put: 'high', carry: true },
        { at: [SPOT.dispatch[0] - 2.6, 0, 9.9] },
      ]} />

      <Environment resolution={256} frames={1}>
        <Lightformer form="rect" intensity={night ? 0.35 : 1.6} position={[0, 12, 0]} rotation-x={Math.PI / 2} scale={[40, 30, 1]} />
        <Lightformer form="rect" intensity={night ? 0.15 : 0.8} position={[-25, 6, 10]} rotation-y={Math.PI / 2} scale={[30, 8, 1]} />
        <Lightformer form="rect" intensity={night ? 0.15 : 0.6} position={[25, 6, -10]} rotation-y={-Math.PI / 2} scale={[30, 8, 1]} />
      </Environment>
      <EffectComposer multisampling={0}>
        <N8AO halfRes aoRadius={1.1} intensity={night ? 1.6 : 2.4} distanceFalloff={0.8} />
        <Bloom mipmapBlur intensity={night ? 1.1 : 0.2} luminanceThreshold={night ? 0.55 : 0.92} luminanceSmoothing={0.2} />
        <SMAA />
        <Vignette offset={0.3} darkness={0.42} />
      </EffectComposer>
      <ContactShadows position={[0, 0.011, 0]} opacity={night ? 0.2 : 0.3} scale={60} blur={2.2} far={6} resolution={512} frames={1} />

      </Names.Provider>
      </Seated.Provider>
      </Crowd.Provider>
      </Talk.Provider>
      {hover && (
        <Html position={[hover.at[0], hover.at[1] + 2.3, hover.at[2]]} center style={{ pointerEvents: 'none' }} zIndexRange={[20, 0]}>
          <Tip h={hover} />
        </Html>
      )}
    </>
  )
}

/* ================================================================ rounds */

type Errand = 'dock' | 'assign' | 'dispatch' | 'parts' | 'purchase'

/** A part pending with Purchase: for which ticket, what, and where it stands. */
type PurchaseItem = { code: string; part: string; status: PartStatus; po?: string | null; edd?: string | null; vendor?: string | null; since?: string; late: boolean }

/**
 * What the coordinator asks at the Purchase desk, and the buyer's answers
 * (the user, 9 Oct: "if any purchase pending, coordinator should go to
 * purchase dept and ask logical questions"): an order past its due date
 * first, then one for a spare past its TAT, then the oldest — each asked
 * about from where it stands: a new request, one not taken up yet, a PO
 * not raised, an order not arrived.
 */
function purchaseTalk(items: PurchaseItem[], buyer: string, me: string): Array<[string, string]> {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const day = (iso: string) => new Date(iso.slice(0, 10) + 'T00:00:00')
  const dated = (iso: string) => day(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  const overdue = (x: PurchaseItem) => !!x.edd && day(x.edd) < today
  const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
  const what = (x: PurchaseItem) => (x.part ? `${x.code}'s ${short(x.part, 22)}` : `${x.code}'s part`)
  const order = [...items].sort((a, b) => Number(overdue(b)) - Number(overdue(a)) || Number(b.late) - Number(a.late) || (a.since ?? '').localeCompare(b.since ?? ''))
  const hey = buyer ? `${buyer}, ` : ''
  const lines: Array<[string, string]> = []
  if (items.length > 1) lines.push([`${hey}${items.length} parts pending with you — a quick update?`, `Sure ${me}, go ahead`])
  for (const x of order.slice(0, 2)) {
    const lead = lines.length ? '' : hey
    const days = x.since ? Math.floor((today.getTime() - day(x.since).getTime()) / 86400000) : 0
    if (x.status === 'requested') lines.push([`${lead}${what(x)} — a new one for you`, `OK ${me}, I'll get quotes`])
    else if (x.status === 'forwarded') lines.push(days >= 2
      ? [`${lead}${what(x)} — ${days} days now. Any vendor yet?`, 'Two quotes in — I\'ll close it today']
      : [`${lead}${what(x)} — did you get my request?`, 'Yes, checking with vendors'])
    else if (x.status === 'accepted') lines.push([`${lead}${what(x)} — PO raised yet?`, x.vendor ? `Yes, going to ${short(x.vendor, 18)}` : `Raising it today, ${me}`])
    else if (x.po) {
      const po = `${x.code}'s ${poLabel(x.po)}`
      lines.push(!x.edd ? [`${lead}${po} — any delivery date?`, 'Vendor says this week']
        : overdue(x) ? [`${lead}${po} was due ${dated(x.edd)} — still not here`, `Sorry ${me} — calling the vendor now`]
        : [`${lead}${po} — when will it reach?`, `Due ${dated(x.edd)}, ${me}`])
    }
  }
  const late = order.find(x => x.late)
  if (late) lines.push([`${late.code} is past TAT — please push it`, 'Will do, top priority'])
  return lines
}

/**
 * A point on a round: how long to stay; whether to sit there, or work at the
 * bench; which way to face; whether to talk and what is said; whether a
 * spare (or a part) is in hand on the way.
 */
type Stop = {
  at: V3; wait?: number; sit?: boolean; work?: boolean; drink?: boolean; face?: number; talk?: boolean; say?: string; carry?: boolean | 'part'
  /** A box is picked up here (it is in hand from halfway through), or put down (it leaves the hand halfway through); low means from or to the floor. */
  pick?: 'low' | 'high'; put?: 'low' | 'high'
  /** Talking to this person, who answers with this, a beat later. */
  to?: string; answer?: string
  /** Sitting at the pantry table: tea, the phone, small talk. */
  pantry?: boolean
  /** On a phone call: phone to the ear, the other hand on the hip. */
  call?: boolean
  /** Wiping down and tidying the bench. */
  tidy?: boolean
  /** Counting stock at the shelf, clipboard in hand. */
  count?: boolean
  /** Standing, looking at the phone. */
  phone?: boolean
}

/** Somebody to go and see at a bench: where to stand in the aisle in front of it, the ticket, what is said. */
type Visit = { x: number; z: number; code: string; say?: string; who?: string; answer?: string; name?: string }

/** Up from a desk and round its end; which end depends on where the desk sits in the row. */
function deskWay(seat: V3, room: { x0: number; x1: number }) {
  const dir = seat[0] < (room.x0 + room.x1) / 2 ? -1 : 1
  return {
    chair: [seat[0], 0, seat[2] - 0.75] as V3,
    side: [seat[0] + 0.97 * dir, 0, seat[2] - 0.75] as V3,
    front: [seat[0] + 0.97 * dir, 0, seat[2] + 0.9] as V3,
  }
}

/** To the coordinator's desk from the left aisle, and back: where people hand over and ask. */
function toCoordinator(coordSeat: V3, from: V3, talk: Stop): { go: Stop[]; back: Stop[] } {
  const x = coordSeat[0] + 0.3
  return {
    go: [{ at: from }, { at: [LEFT_AISLE, 0, COORD_ROOM_FRONT + 0.4] }, { at: [x, 0, COORD_ROOM_FRONT + 0.4] }, { ...talk, at: [x, 0, coordSeat[2] + 0.95] }],
    back: [{ at: [x, 0, COORD_ROOM_FRONT + 0.4] }, { at: [LEFT_AISLE, 0, COORD_ROOM_FRONT + 0.4] }, { at: from }],
  }
}

/**
 * A coordinator's round (the user, 8 Oct: "walking through the tables, no
 * logic in it"). Up from the desk, round its end, out of the room and along
 * the front corridor — to the dock for what has arrived (carried back to be
 * accepted), to the engineer with least on the bench with a spare to assign,
 * to dispatch with what goes back — and home the same way.
 */
function coordinatorRound(seat: V3, errands: Errand[], assign: Visit | null, nth: number, partsTo: Visit | null = null, purchase: { seat: V3; who: string; lines: Array<[string, string]> } | null = null): Stop[] {
  const w = deskWay(seat, ROOM.coordinator)
  const chair: Stop = { at: w.chair, wait: 6 + nth * 4, sit: true }
  const roomExit: V3 = [w.side[0], 0, COORD_ROOM_FRONT + 0.5]
  const corner: V3 = [w.side[0], 0, FRONT_CORRIDOR]
  const there = (to: Stop[], carryOut = false, carryBack = false): Stop[] => [
    { at: w.side, carry: carryOut }, { at: w.front, carry: carryOut }, { at: roomExit, carry: carryOut }, { at: corner, carry: carryOut },
    ...to.map(s => ({ carry: carryOut, ...s })),
    { at: corner, carry: carryBack }, { at: roomExit, carry: carryBack }, { at: w.front, carry: carryBack }, { at: w.side, carry: carryBack },
    { ...chair, carry: carryBack },
  ]
  const round: Stop[] = [chair]
  for (const e of errands) {
    if (e === 'dock') {
      round.push(...there([{ at: [SPOT.dock[0] + 1.5, 0, 5.6], wait: 2.6, face: Math.PI * 0.75, say: 'Received — checking it in' }], false, true))
    }
    if (e === 'assign' && assign) {
      round.push(...there([
        { at: [LEFT_AISLE, 0, FRONT_CORRIDOR] }, { at: [LEFT_AISLE, 0, assign.z] },
        { at: [assign.x, 0, assign.z], wait: 4, face: Math.PI, talk: true, say: `${assign.name ? assign.name + ', ' : ''}${assign.code} for you — priority, please`, to: assign.who, answer: assign.answer },
        { at: [LEFT_AISLE, 0, assign.z], carry: false }, { at: [LEFT_AISLE, 0, FRONT_CORRIDOR], carry: false },
      ], true, false))
    }
    if (e === 'parts' && partsTo) {
      // To the shelf, the part off it, and along to the engineer who needs it.
      const shelfX = SPOT.shelf[0] - 1.05, shelfZ = SPOT.shelf[2]
      round.push(...there([
        { at: [RIGHT_AISLE, 0, FRONT_CORRIDOR] }, { at: [RIGHT_AISLE, 0, shelfZ] },
        { at: [shelfX, 0, shelfZ], wait: 2, face: Math.PI / 2, pick: 'high', carry: 'part' },
        { at: [RIGHT_AISLE, 0, shelfZ], carry: 'part' }, { at: [RIGHT_AISLE, 0, partsTo.z], carry: 'part' },
        { at: [partsTo.x, 0, partsTo.z], wait: 3.6, face: Math.PI, put: 'high', carry: 'part', say: `${partsTo.name ? 'Hey ' + partsTo.name + ', p' : 'P'}arts for ${partsTo.code}`, to: partsTo.who, answer: partsTo.answer },
        { at: [RIGHT_AISLE, 0, partsTo.z] }, { at: [RIGHT_AISLE, 0, FRONT_CORRIDOR] },
      ]))
    }
    if (e === 'purchase' && purchase && purchase.lines.length) {
      // Along the back to the Purchase cabin, what is pending with them gone through at the buyer's desk, and back.
      const doorX = (ROOM.purchase.x0 + ROOM.purchase.x1) / 2
      const desk: V3 = [purchase.seat[0], 0, purchase.seat[2] + 0.95]
      round.push(
        { at: w.side }, { at: w.front }, { at: roomExit }, { at: [LEFT_AISLE, 0, COORD_ROOM_FRONT + 0.5] }, { at: [LEFT_AISLE, 0, BACK_CORRIDOR] },
        { at: [doorX, 0, BACK_CORRIDOR] }, { at: [doorX, 0, CABIN_FRONT + 0.2] }, { at: [purchase.seat[0], 0, CABIN_FRONT - 0.4] },
        ...purchase.lines.map(([say, answer]) => ({ at: desk, wait: 5.5, face: Math.PI, talk: true, say, to: purchase.who, answer })),
        { at: [purchase.seat[0], 0, CABIN_FRONT - 0.4] }, { at: [doorX, 0, CABIN_FRONT + 0.2] }, { at: [doorX, 0, BACK_CORRIDOR] },
        { at: [LEFT_AISLE, 0, BACK_CORRIDOR] }, { at: [LEFT_AISLE, 0, COORD_ROOM_FRONT + 0.5] }, { at: roomExit }, { at: w.front }, { at: w.side }, chair,
      )
    }
    if (e === 'dispatch') {
      const x = SPOT.dispatch[0] - 1.5
      round.push(...there([
        { at: [x, 0, FRONT_CORRIDOR] }, { at: [x, 0, 5.8], wait: 2.6, face: Math.PI / 2, say: 'Packed — going back today' },
        { at: [x, 0, FRONT_CORRIDOR], carry: false },
      ], true, false))
    }
  }
  return round
}

/**
 * Out of a cabin and back (the user, 8 Oct: "admin should sometimes go and
 * sit in the cabin ... admin need to check the pending talk with eng and
 * coordinator"): a long sit at the desk, then to each engineer to be seen —
 * standing in the aisle in front of the bench, talking — then, for the admin,
 * the coordinator's desk; and back to sit down again.
 */
function cabinRound(room: 'admin' | 'manager', seat: V3, visits: Visit[], sitFor: number, coordinator?: { seat: V3; who?: string; lines: Array<[string, string]> }, bench?: { home: V3; behindZ: number }): Stop[] {
  const w = deskWay(seat, ROOM[room])
  const chair: Stop = { at: w.chair, wait: sitFor, sit: true }
  if (!visits.length && !coordinator && !bench) return [chair]
  const doorX = (ROOM[room].x0 + ROOM[room].x1) / 2
  const door: V3 = [doorX, 0, CABIN_FRONT + 0.2]
  const hall: V3 = [doorX, 0, BACK_CORRIDOR]
  const aisle = doorX < 1 ? LEFT_AISLE : RIGHT_AISLE
  const stops: Stop[] = [chair, { at: w.side }, { at: w.front }, { at: [doorX, 0, w.front[2]] }, { at: door }, { at: hall }]
  if (bench) {
    // Down the aisle, along the gap behind the bench row, a good spell of repair, and back the same way.
    const [bx, , ] = bench.home
    stops.push(
      { at: [aisle, 0, BACK_CORRIDOR] }, { at: [aisle, 0, bench.behindZ] }, { at: [bx, 0, bench.behindZ] },
      { at: bench.home, wait: 24, work: true, face: 0 },
      { at: [bx, 0, bench.behindZ] }, { at: [aisle, 0, bench.behindZ] }, { at: [aisle, 0, BACK_CORRIDOR] },
    )
  }
  if (visits.length) {
    stops.push({ at: [aisle, 0, BACK_CORRIDOR] })
    for (const v of visits) {
      stops.push({ at: [aisle, 0, v.z] }, { at: [v.x, 0, v.z], wait: 5, face: Math.PI, talk: true, say: v.say, to: v.who, answer: v.answer }, { at: [aisle, 0, v.z] })
    }
    stops.push({ at: [aisle, 0, BACK_CORRIDOR] })
  }
  if (coordinator && coordinator.lines.length) {
    const [first, ...more] = coordinator.lines
    const c = toCoordinator(coordinator.seat, [LEFT_AISLE, 0, BACK_CORRIDOR], { at: [0, 0, 0], wait: 5.5, face: Math.PI, talk: true, say: first[0], to: coordinator.who, answer: first[1] })
    const desk = c.go[c.go.length - 1]
    // Then the rest of what there is to ask, at the same desk, each in turn.
    c.go.push(...more.map(([say, answer]) => ({ ...desk, say, answer })))
    stops.push(...c.go, ...c.back)
  }
  stops.push({ at: hall }, { at: door }, { at: [doorX, 0, w.front[2]] }, { at: w.front }, { at: w.side })
  return stops
}

/**
 * An engineer's round from the bench (the user, 8 Oct: "let engineer go
 * with spare to coordinator after repairing"): a good while repairing, then —
 * a repair just done — the spare to the coordinator's desk, and — parts ready
 * — a walk to the parts shelf and back with them. Along the gap behind the
 * row, never across a bench.
 */
const CHATS = [['Tea after this?', 'Yes, 4 o\'clock'], ['That board was tricky', 'Reflow fixed mine'], ['Weekend plans?', 'Home, finally!']]
function engineerRound(home: V3, behindZ: number, coordSeat: V3, repaired: string | null, parts: string | null, i: number, water?: { slot: 0 | 1; pair: number; partner: string }, talk?: [string, string, string]): Stop[] {
  // A good spell of work between errands, different for each engineer, so getting up is now and then — not a shuttle
  // (the user, 9 Oct: "the eng keeping repaired boxes to coordinator is repeating very fast").
  const bench: Stop = { at: home, wait: water ? 80 + ((i * 53) % 70) : 60 + ((i * 37) % 120), work: true, face: 0 }
  const behind: V3 = [home[0], 0, behindZ]
  const stops: Stop[] = [bench, { at: behind }]
  if (repaired) {
    const c = toCoordinator(coordSeat, [LEFT_AISLE, 0, behindZ], { at: [0, 0, 0], wait: 3.6, face: Math.PI, talk: true, say: `${repaired} repaired ✓` })
    stops.push({ at: [LEFT_AISLE, 0, behindZ], carry: true }, ...c.go.slice(1).map(s => ({ carry: true, ...s })), ...c.back.map(s => ({ ...s, carry: false })))
  }
  if (parts) {
    const shelfX = SPOT.shelf[0] - 1.05, shelfZ = SPOT.shelf[2] + (i % 3) - 1
    stops.push(
      { at: [RIGHT_AISLE, 0, behindZ] }, { at: [RIGHT_AISLE, 0, shelfZ] },
      { at: [shelfX, 0, shelfZ], wait: 2.6, face: Math.PI / 2, say: `Parts for ${parts}` },
      { at: [RIGHT_AISLE, 0, shelfZ], carry: 'part' }, { at: [RIGHT_AISLE, 0, behindZ], carry: 'part' },
    )
  }
  if (water) {
    // To the cooler, a drink, a few words with the other one, and back.
    const mine: V3 = water.slot ? [COOLER[0] - 1.0, 0, COOLER[2] + 0.55] : [COOLER[0] - 0.8, 0, COOLER[2] - 0.1]
    const theirs: V3 = water.slot ? [COOLER[0] - 0.8, 0, COOLER[2] - 0.1] : [COOLER[0] - 1.0, 0, COOLER[2] + 0.55]
    const face = Math.atan2(theirs[0] - mine[0], theirs[2] - mine[2])
    const inside = PANTRY_IN.map(at => ({ at }))
    const lines = talk ?? CHATS[water.pair % CHATS.length].concat('') as unknown as [string, string, string]
    stops.push(
      { at: [RIGHT_AISLE, 0, behindZ] }, { at: [RIGHT_AISLE, 0, BACK_CORRIDOR] }, ...inside, { at: mine },
      { at: mine, wait: 3.2, face: Math.PI / 2, drink: true },
      // Turn about: one asks, the other answers, the first replies.
      // Turn about: the first asks and the other answers, then the first replies; the other only listens and answers.
      water.slot === 0
        ? { at: mine, wait: 5, face, talk: true, say: lines[0], to: water.partner, answer: lines[1] }
        : { at: mine, wait: 5, face, talk: true },
      water.slot === 0
        ? { at: mine, wait: 3, face, talk: true, say: lines[2] }
        : { at: mine, wait: 3, face, talk: true },
      ...[...inside].reverse(), { at: [RIGHT_AISLE, 0, BACK_CORRIDOR] }, { at: [RIGHT_AISLE, 0, behindZ] },
    )
  }
  stops.push({ at: behind, carry: parts ? 'part' : false })
  return stops
}

/** Purchase, with parts that have come in: from the cabin to the shelf and back. */
function purchaseRound(seat: V3): Stop[] {
  const w = deskWay(seat, ROOM.purchase)
  const doorX = (ROOM.purchase.x0 + ROOM.purchase.x1) / 2
  const shelfX = SPOT.shelf[0] - 1.05
  return [
    { at: w.chair, wait: 40, sit: true }, { at: w.side }, { at: w.front }, { at: [doorX, 0, w.front[2]] },
    { at: [doorX, 0, CABIN_FRONT + 0.2], carry: 'part' }, { at: [doorX, 0, BACK_CORRIDOR], carry: 'part' },
    { at: [shelfX, 0, BACK_CORRIDOR], carry: 'part' }, { at: [shelfX, 0, SPOT.shelf[2] - 1.4], carry: 'part' },
    { at: [shelfX, 0, SPOT.shelf[2] - 1.4], wait: 2.6, face: Math.PI / 2, say: 'Parts are in' },
    { at: [shelfX, 0, BACK_CORRIDOR] }, { at: [doorX, 0, BACK_CORRIDOR] }, { at: [doorX, 0, CABIN_FRONT + 0.2] },
    { at: [doorX, 0, w.front[2]] }, { at: w.front }, { at: w.side },
  ]
}

/* ================================================================ camera */

/** What the on-screen pad is holding down, shared with the camera inside the canvas. */
export type PadAction = 'fwd' | 'back' | 'left' | 'right' | 'turnL' | 'turnR' | 'in' | 'out'
type Pad = { held: Set<PadAction>; reset: boolean }

const HOME_CAMERA: V3 = [20, 21, 27]
const HOME_TARGET: V3 = [0, 0, 0.5]

/**
 * Looking and going anywhere on the floor (the user, 8 Oct: "with mouse we
 * need to change perspective also"): drag to turn and tilt the view,
 * right-drag or two fingers to move across the floor, scroll or pinch to go
 * in close. Arrow keys or
 * W A S D walk, Q and E turn; the pad on screen does the same for a mouse or
 * a finger. The view stays over the grounds and above the floor.
 */
function Roam({ pad }: { pad: React.MutableRefObject<Pad> }) {
  const controls = useRef<React.ElementRef<typeof OrbitControls>>(null)
  const keys = useRef(new Set<string>())
  useEffect(() => {
    const map: Record<string, PadAction> = {
      arrowup: 'fwd', w: 'fwd', arrowdown: 'back', s: 'back', arrowleft: 'left', a: 'left',
      arrowright: 'right', d: 'right', q: 'turnL', e: 'turnR', '+': 'in', '=': 'in', '-': 'out',
    }
    const typing = (e: KeyboardEvent) =>
      e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (map[k] && !typing(e)) { keys.current.add(map[k]); e.preventDefault() }
    }
    const up = (e: KeyboardEvent) => { const k = e.key.toLowerCase(); if (map[k]) keys.current.delete(map[k]) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [])
  useFrame(({ camera }, dt) => {
    const c = controls.current
    if (!c) return
    if (pad.current.reset) {
      pad.current.reset = false
      camera.position.set(...HOME_CAMERA); c.target.set(...HOME_TARGET); c.update()
    }
    const on = (a: PadAction) => keys.current.has(a) || pad.current.held.has(a)
    const fwd = (on('fwd') ? 1 : 0) - (on('back') ? 1 : 0)
    const side = (on('right') ? 1 : 0) - (on('left') ? 1 : 0)
    if (fwd || side) {
      const dir = c.target.clone().sub(camera.position); dir.y = 0; dir.normalize()
      const right = dir.clone().cross(camera.up).normalize()
      const move = dir.multiplyScalar(fwd).add(right.multiplyScalar(side)).multiplyScalar(dt * 9)
      camera.position.add(move); c.target.add(move)
    }
    const turn = (on('turnL') ? 1 : 0) - (on('turnR') ? 1 : 0)
    if (turn) {
      const off = camera.position.clone().sub(c.target)
      off.applyAxisAngle(camera.up, turn * dt * 1.1)
      camera.position.copy(c.target).add(off)
    }
    const zoom = (on('in') ? 1 : 0) - (on('out') ? 1 : 0)
    if (zoom) {
      const off = camera.position.clone().sub(c.target)
      const d = Math.max(2.5, Math.min(58, off.length() * (1 - zoom * dt * 1.4)))
      camera.position.copy(c.target).add(off.setLength(d))
    }
    const t = c.target
    const cx = Math.max(-26, Math.min(26, t.x)), cz = Math.max(-16, Math.min(20, t.z))
    if (cx !== t.x || cz !== t.z || t.y !== 0) {
      const back = { x: cx - t.x, y: 0 - t.y, z: cz - t.z }
      t.set(cx, 0, cz); camera.position.x += back.x; camera.position.y += back.y; camera.position.z += back.z
    }
    if (camera.position.y < 1.2) camera.position.y = 1.2
  })
  return (
    <OrbitControls ref={controls} target={HOME_TARGET} enablePan screenSpacePanning={false} panSpeed={1.1}
      mouseButtons={{ LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN }}
      touches={{ ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_PAN }}
      minDistance={2.5} maxDistance={58} minPolarAngle={0.2} maxPolarAngle={1.42}
      enableDamping dampingFactor={0.08} makeDefault />
  )
}

/* ================================================================ light */

function Sky() {
  const night = useNight()
  const sky = night ? '#0A1222' : '#CFE4F5'
  return (
    <>
      <color attach="background" args={[sky]} />
      <fog attach="fog" args={[sky, 60, 115]} />
      <hemisphereLight args={night ? ['#3A4A7A', '#0B1018', 0.35] : ['#FFFFFF', '#8FA77A', 0.75]} />
      {night && <Stars radius={90} depth={30} count={1800} factor={3.5} saturation={0} fade speed={0.4} />}
    </>
  )
}

/** Ceiling lamps over each part of the floor, lit at night; shadows stay with the moon, so it stays smooth. */
const LAMPS: Array<[number, number]> = [
  [-12.2, -7], [-12.2, -1], [-5.4, -7], [0.8, -7], [7, -7], [12.5, -7],
  [-5, -2.4], [0.5, -2.4], [6, -2.4], [-5, 2.2], [0.5, 2.2], [6, 2.2], [10.4, 0],
  [-12.2, 7.1], [12.2, 7.1], [-12.2, 3], [14.6, -0.6],
]
function Lamps() {
  return (
    <group>
      {LAMPS.map(([x, z], i) => (
        <group key={i} position={[x, 3.3, z]}>
          <mesh>
            <cylinderGeometry args={[0.35, 0.45, 0.12, 20]} />
            <meshStandardMaterial color="#FFE7B8" emissive="#FFD48A" emissiveIntensity={2.2} />
          </mesh>
          <pointLight color="#FFD9A0" intensity={8} distance={8} decay={2} position={[0, -0.3, 0]} />
        </group>
      ))}
    </group>
  )
}

/* ================================================================ hover card */

function Tip({ h }: { h: Hover }) {
  if (h.kind === 'person') {
    return (
      <div className="w-56 rounded-lg border border-ink-200 bg-surface px-3 py-2 text-xs shadow-lg">
        <p className="text-sm font-semibold text-ink-900">{h.crew.full_name}</p>
        <p className="text-ink-500">{h.crew.ecode}{h.crew.designation ? ` · ${h.crew.designation}` : ''}</p>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {h.roles.map(r => (
            <span key={r} className="rounded-full px-2 py-0.5 text-[11px] font-medium text-white" style={{ background: UNIFORM[r].color }}>
              {UNIFORM[r].label}
            </span>
          ))}
        </div>
        {h.load && <p className="mt-1.5 text-ink-700">{h.load}</p>}
      </div>
    )
  }
  const t = h.t
  return (
    <div className="w-60 rounded-lg border border-ink-200 bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="text-sm font-semibold text-ink-900">{t.code}</p>
      <p className="text-ink-700">{itemsSummary(t) ?? t.equipment_name ?? 'Spare'}</p>
      <p className="text-ink-500">{t.facility}</p>
      <p className="mt-1 font-medium text-ink-800">{STATUS[t.status]?.label ?? t.status}</p>
      {t.engineer_name && <p className="text-ink-600">With {t.engineer_name}</p>}
      {h.late && <p className="font-medium text-cyrixRed-700">Past its TAT</p>}
      {h.mine && <p className="font-medium text-amber-700">Waiting on you</p>}
      <p className="mt-1 text-ink-400">Click to open</p>
    </div>
  )
}

/* ================================================================ building */

function Ground() {
  const grass = useGrassTexture()
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, 2]} receiveShadow>
        <planeGeometry args={[140, 110]} />
        <meshStandardMaterial map={grass} color="#A8CC86" roughness={1} />
      </mesh>
      {/* The road: asphalt, kerbs, a dashed centre line and edge lines */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.004, ROAD_Z]} receiveShadow>
        <planeGeometry args={[140, 6]} />
        <meshStandardMaterial color="#4B5157" roughness={0.92} />
      </mesh>
      {[-3.08, 3.08].map(d => (
        <mesh key={d} position={[0, 0.07, ROAD_Z + d]} receiveShadow castShadow>
          <boxGeometry args={[140, 0.14, 0.16]} />
          <meshStandardMaterial color="#D4D4D4" roughness={0.8} />
        </mesh>
      ))}
      {[-2.75, 2.75].map(d => (
        <mesh key={`e${d}`} rotation-x={-Math.PI / 2} position={[0, 0.008, ROAD_Z + d]}>
          <planeGeometry args={[140, 0.12]} />
          <meshStandardMaterial color="#E5E7EB" />
        </mesh>
      ))}
      {Array.from({ length: 35 }, (_, i) => (
        <mesh key={i} rotation-x={-Math.PI / 2} position={[-68 + i * 4, 0.009, ROAD_Z]}>
          <planeGeometry args={[2, 0.14]} />
          <meshStandardMaterial color="#F5F5F4" />
        </mesh>
      ))}
      {/* Footpath on the far side */}
      <mesh position={[0, 0.06, ROAD_Z + 4.0]} receiveShadow>
        <boxGeometry args={[140, 0.12, 1.6]} />
        <meshStandardMaterial color="#BDB8AE" roughness={0.95} />
      </mesh>
      {/* The apron in front of the docks, where the trucks pull in */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.006, (HALF_Z + ROAD_Z - 3.1) / 2]} receiveShadow>
        <planeGeometry args={[HALF_X * 2 + 6, ROAD_Z - 3.1 - HALF_Z]} />
        <meshStandardMaterial color="#A9AEB4" roughness={0.9} />
      </mesh>
      {[SPOT.dock[0], SPOT.dispatch[0]].map(x => (
        <group key={x}>
          {[-1.6, 1.6].map(d => (
            <mesh key={d} rotation-x={-Math.PI / 2} position={[x + d, 0.01, APRON_Z]}>
              <planeGeometry args={[0.1, 3.4]} />
              <meshStandardMaterial color="#FACC15" />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  )
}

/** A grass texture, drawn once: speckled greens so the lawn is not one flat colour. */
function useGrassTexture() {
  return useMemo(() => {
    const c = document.createElement('canvas')
    c.width = c.height = 256
    const g = c.getContext('2d')!
    g.fillStyle = '#7FAF5C'
    g.fillRect(0, 0, 256, 256)
    const greens = ['#6E9F4E', '#8DBB66', '#79A956', '#94C06E', '#668F47']
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = greens[i % greens.length]
      const x = (i * 97.13) % 256, y = (i * 57.71 + (i % 7) * 13) % 256
      g.fillRect(x, y, 2 + (i % 3), 1 + (i % 2))
    }
    const t = new CanvasTexture(c)
    t.wrapS = t.wrapT = RepeatWrapping
    t.repeat.set(36, 28)
    t.colorSpace = SRGBColorSpace
    return t
  }, [])
}

/**
 * Words drawn onto a texture, so signs and floor markings are part of the
 * scene — lit, shadowed, glowing at night — rather than labels floating over
 * it (the user, 8 Oct: "the dept name board is not attractive ... trc name
 * board also not good").
 */
function useTextTexture(text: string, o: { w?: number; h?: number; color?: string; bg?: string; weight?: number; spacing?: number; size?: number } = {}) {
  const { w = 1024, h = 160, color = '#FFFFFF', bg, weight = 700, spacing = 6, size = 0.62 } = o
  return useMemo(() => {
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const g = c.getContext('2d')!
    if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, h) }
    let px = Math.round(h * size)
    const font = () => `${weight} ${px}px Inter, "Segoe UI", system-ui, sans-serif`
    g.font = font()
    ;(g as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${spacing}px`
    while (g.measureText(text).width > w * 0.92 && px > 10) { px -= 2; g.font = font() }
    g.fillStyle = color
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, w / 2, h / 2 + px * 0.04)
    const t = new CanvasTexture(c)
    t.colorSpace = SRGBColorSpace
    t.anisotropy = 8
    return t
  }, [text, w, h, color, bg, weight, spacing, size])
}

/**
 * Floors drawn once: big pale porcelain tiles with fine grout and a little
 * variation from tile to tile; a blue-grey speckled epoxy for the
 * anti-static repair area; a charcoal carpet tile for the rooms.
 */
function useFloorTextures() {
  return useMemo(() => {
    const make = (size: number, draw: (g: CanvasRenderingContext2D) => void, repeat: [number, number]) => {
      const c = document.createElement('canvas')
      c.width = c.height = size
      draw(c.getContext('2d')!)
      const t = new CanvasTexture(c)
      t.wrapS = t.wrapT = RepeatWrapping
      t.repeat.set(...repeat)
      t.colorSpace = SRGBColorSpace
      t.anisotropy = 8
      return t
    }
    const tiles = make(512, g => {
      const tones = ['#3A3F47', '#363B43', '#3D424A', '#33383F', '#393E46', '#373C44']
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        g.fillStyle = tones[(x * 3 + y * 5) % tones.length]
        g.fillRect(x * 128, y * 128, 128, 128)
        // A faint vein across each tile, the way polished porcelain looks.
        g.strokeStyle = 'rgba(200,206,214,0.08)'; g.lineWidth = 1.2
        g.beginPath(); g.moveTo(x * 128 + 10, y * 128 + 30 + (x * 17) % 60)
        g.bezierCurveTo(x * 128 + 50, y * 128 + 10, x * 128 + 80, y * 128 + 110, x * 128 + 120, y * 128 + 70 - (y * 13) % 40)
        g.stroke()
      }
      g.fillStyle = '#5A616B'
      for (let k = 0; k <= 4; k++) { g.fillRect(k * 128 - 1, 0, 2, 512); g.fillRect(0, k * 128 - 1, 512, 2) }
    }, [(HALF_X * 2) / 4.8, (HALF_Z * 2) / 4.8])
    const epoxy = make(256, g => {
      g.fillStyle = '#7E93A8'; g.fillRect(0, 0, 256, 256)
      for (let i = 0; i < 2600; i++) {
        g.fillStyle = ['#6F849A', '#8DA2B6', '#768BA0', '#9AAEC0'][i % 4]
        g.fillRect((i * 73.13) % 256, (i * 41.71 + (i % 11) * 7) % 256, 1.5, 1.5)
      }
    }, [8, 4])
    const carpet = make(256, g => {
      g.fillStyle = '#22262D'; g.fillRect(0, 0, 256, 256)
      for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) {
        g.fillStyle = (x + y) % 2 ? '#262B33' : '#1F2329'
        g.fillRect(x * 128, y * 128, 128, 128)
        g.strokeStyle = 'rgba(255,255,255,0.04)'
        for (let k = 0; k < 128; k += 6) { g.beginPath(); g.moveTo(x * 128 + ((x + y) % 2 ? k : 0), y * 128 + ((x + y) % 2 ? 0 : k)); g.lineTo(x * 128 + ((x + y) % 2 ? k : 128), y * 128 + ((x + y) % 2 ? 128 : k)); g.stroke() }
      }
    }, [6, 2])
    return { tiles, epoxy, carpet }
  }, [])
}

const GLASS = <meshStandardMaterial color="#BFD9F0" transparent opacity={0.26} roughness={0.04} metalness={0.2} />
const STEEL = <meshStandardMaterial color="#5B6573" metalness={0.65} roughness={0.38} />

function Building({ name }: { name: string }) {
  const night = useNight()
  const floor = useFloorTextures()
  const wall = '#ECEEF1', trim = '#C9CED4'
  const W = HALF_X * 2, D = HALF_Z * 2
  return (
    <group>
      {/* Floor: large polished porcelain tiles; the repair area in anti-static epoxy; carpet in the rooms */}
      <mesh position={[0, 0.05, 0]} castShadow>
        <boxGeometry args={[W, 0.1, D]} />
        <meshStandardMaterial color="#C9CED4" />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.101, 0]} receiveShadow>
        <planeGeometry args={[W - 0.1, D - 0.1]} />
        <meshStandardMaterial map={floor.tiles} roughness={0.24} metalness={0.08} envMapIntensity={1.1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[(BENCH_AREA.x0 + BENCH_AREA.x1) / 2, 0.1025, (BENCH_AREA.z0 + BENCH_AREA.z1) / 2]} receiveShadow>
        <planeGeometry args={[BENCH_AREA.x1 - BENCH_AREA.x0 + 0.7, BENCH_AREA.z1 - BENCH_AREA.z0 + 0.5]} />
        <meshStandardMaterial color="#EAB308" />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[(BENCH_AREA.x0 + BENCH_AREA.x1) / 2, 0.103, (BENCH_AREA.z0 + BENCH_AREA.z1) / 2]} receiveShadow>
        <planeGeometry args={[BENCH_AREA.x1 - BENCH_AREA.x0 + 0.5, BENCH_AREA.z1 - BENCH_AREA.z0 + 0.3]} />
        <meshStandardMaterial map={floor.epoxy} roughness={0.32} metalness={0.05} />
      </mesh>
      {(['coordinator', 'manager', 'admin', 'purchase'] as const).map(r => {
        const front = r === 'coordinator' ? COORD_ROOM_FRONT : CABIN_FRONT
        return (
          <mesh key={r} rotation-x={-Math.PI / 2} position={[(ROOM[r].x0 + ROOM[r].x1) / 2, 0.1035, (front - HALF_Z) / 2]} receiveShadow>
            <planeGeometry args={[ROOM[r].x1 - ROOM[r].x0 - 0.05, HALF_Z + front - 0.2]} />
            <meshStandardMaterial map={floor.carpet} roughness={0.95} />
          </mesh>
        )
      })}
      {[FRONT_CORRIDOR + 0.5, BACK_CORRIDOR + 0.45].map(z => (
        <mesh key={z} rotation-x={-Math.PI / 2} position={[1.6, 0.1045, z]}>
          <planeGeometry args={[19.6, 0.08]} />
          <meshStandardMaterial color="#EAB308" />
        </mesh>
      ))}
      {/* Walls: back and left full height with a coping, right low; a skirting along their foot */}
      <mesh position={[0, 1.6, -HALF_Z]} castShadow receiveShadow>
        <boxGeometry args={[W, 3.2, 0.25]} />
        <meshStandardMaterial color={wall} roughness={0.85} />
      </mesh>
      <mesh position={[0, 3.24, -HALF_Z]}><boxGeometry args={[W + 0.1, 0.1, 0.35]} /><meshStandardMaterial color={trim} /></mesh>
      <mesh position={[0, 0.16, -HALF_Z + 0.14]}><boxGeometry args={[W, 0.12, 0.03]} /><meshStandardMaterial color="#64748B" /></mesh>
      <mesh position={[-HALF_X, 1.6, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.25, 3.2, D]} />
        <meshStandardMaterial color={wall} roughness={0.85} />
      </mesh>
      <mesh position={[-HALF_X, 3.24, 0]}><boxGeometry args={[0.35, 0.1, D + 0.1]} /><meshStandardMaterial color={trim} /></mesh>
      <mesh position={[HALF_X, 0.6, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.25, 1.2, D]} />
        <meshStandardMaterial color={trim} roughness={0.8} />
      </mesh>
      {/* Windows with frames and a mullion; warm light behind them at night */}
      {Array.from({ length: 9 }, (_, i) => (
        <group key={i} position={[-13.6 + i * 3.4, 2.05, -HALF_Z + 0.14]}>
          <mesh><boxGeometry args={[1.9, 1.0, 0.04]} /><meshStandardMaterial color="#334155" metalness={0.5} roughness={0.4} /></mesh>
          <mesh position={[0, 0, 0.01]}>
            <boxGeometry args={[1.78, 0.88, 0.03]} />
            <meshStandardMaterial color={night ? '#FFE2A8' : '#9CC3E6'} metalness={0.35} roughness={0.08}
              emissive={night ? '#FFB84D' : '#000000'} emissiveIntensity={night ? 0.9 : 0} />
          </mesh>
          <mesh position={[0, 0, 0.03]}><boxGeometry args={[0.04, 0.9, 0.02]} /><meshStandardMaterial color="#334155" /></mesh>
        </group>
      ))}
      {/* Split AC units between the windows */}
      {[-11.9, -5.1, 1.7, 8.5].map(x => (
        <group key={x} position={[x, 2.85, -HALF_Z + 0.28]}>
          <RoundedBox args={[1.0, 0.3, 0.24]} radius={0.06} castShadow><meshStandardMaterial color="#F8FAFC" roughness={0.4} /></RoundedBox>
          <mesh position={[0, -0.1, 0.122]}><boxGeometry args={[0.85, 0.03, 0.01]} /><meshStandardMaterial color="#CBD5E1" /></mesh>
          <mesh position={[0.38, 0.05, 0.122]}><circleGeometry args={[0.012, 8]} /><meshStandardMaterial color="#22C55E" emissive="#22C55E" emissiveIntensity={1.5} /></mesh>
        </group>
      ))}
      {/* Steel columns along the walls */}
      {[-12, -8, -4, 0, 4, 8, 12].map(x => (
        <mesh key={`c${x}`} position={[x, 1.65, -HALF_Z + 0.3]} castShadow><boxGeometry args={[0.28, 3.3, 0.28]} />{STEEL}</mesh>
      ))}
      {[-6, -2, 2, 6].map(z => (
        <mesh key={`cz${z}`} position={[-HALF_X + 0.3, 1.65, z]} castShadow><boxGeometry args={[0.28, 3.3, 0.28]} />{STEEL}</mesh>
      ))}
      {/* Low front kerb between the docks, roller shutters over the dock openings */}
      <mesh position={[0, 0.3, HALF_Z]} castShadow>
        <boxGeometry args={[19, 0.6, 0.25]} />
        <meshStandardMaterial color={trim} roughness={0.8} />
      </mesh>
      {[SPOT.dock[0], SPOT.dispatch[0]].map(x => (
        <group key={`s${x}`} position={[x, 0, HALF_Z]}>
          {[-3.2, 3.2].map(d => <mesh key={d} position={[d, 1.7, 0]} castShadow><boxGeometry args={[0.2, 3.4, 0.25]} />{STEEL}</mesh>)}
          <mesh position={[0, 3.3, 0]} rotation-z={Math.PI / 2} castShadow><cylinderGeometry args={[0.28, 0.28, 6.4, 18]} /><meshStandardMaterial color="#94A3B8" metalness={0.6} roughness={0.35} /></mesh>
          <mesh position={[0, 2.85, 0.02]}><boxGeometry args={[6.2, 0.7, 0.05]} /><meshStandardMaterial color="#A3ACB8" metalness={0.5} roughness={0.4} /></mesh>
          {[0, 1, 2, 3].map(k => <mesh key={k} position={[0, 2.55 + k * 0.17, 0.05]}><boxGeometry args={[6.2, 0.02, 0.02]} /><meshStandardMaterial color="#7C8796" /></mesh>)}
          {/* Bollards */}
          {[-3.6, 3.6].map(d => (
            <group key={`b${d}`} position={[d, 0, 1.0]}>
              <mesh position={[0, 0.5, 0]} castShadow><cylinderGeometry args={[0.1, 0.1, 1, 14]} /><meshStandardMaterial color="#FACC15" roughness={0.5} /></mesh>
              {[0.35, 0.7].map(y => <mesh key={y} position={[0, y, 0]}><cylinderGeometry args={[0.102, 0.102, 0.08, 14]} /><meshStandardMaterial color="#111827" /></mesh>)}
            </group>
          ))}
        </group>
      ))}
      {/* Fire extinguishers by the docks and the rooms */}
      {[[-HALF_X + 0.25, 4.8], [HALF_X - 0.3, 4.8], [-8.9, -3.9], [3.9, -5.6]].map(([x, z]) => (
        <group key={`f${x}${z}`} position={[x, 0, z]}>
          <mesh position={[0, 0.32, 0]} castShadow><capsuleGeometry args={[0.08, 0.36, 6, 12]} /><meshStandardMaterial color="#DC2626" roughness={0.35} /></mesh>
          <mesh position={[0, 0.62, 0]}><cylinderGeometry args={[0.03, 0.04, 0.08, 8]} /><meshStandardMaterial color="#111827" /></mesh>
        </group>
      ))}
      {/* Glass fronts to the cabins with a door gap, glass between them, a header rail */}
      {(['manager', 'admin', 'purchase', 'pantry'] as const).map(r => {
        const { x0, x1 } = ROOM[r], mid = (x0 + x1) / 2, half = (x1 - x0) / 2
        return (
          <group key={r}>
            <mesh position={[x0 + (half - 0.6) / 2, 1.1, CABIN_FRONT]}><boxGeometry args={[half - 0.6, 2.2, 0.05]} />{GLASS}</mesh>
            <mesh position={[x1 - (half - 0.6) / 2, 1.1, CABIN_FRONT]}><boxGeometry args={[half - 0.6, 2.2, 0.05]} />{GLASS}</mesh>
            {[x0, mid - 0.6, mid + 0.6, x1].map(x => <mesh key={x} position={[x, 1.1, CABIN_FRONT]}><boxGeometry args={[0.05, 2.2, 0.07]} /><meshStandardMaterial color="#64748B" metalness={0.6} /></mesh>)}
            <mesh position={[mid, 2.22, CABIN_FRONT]}><boxGeometry args={[(x1 - x0), 0.08, 0.1]} /><meshStandardMaterial color="#64748B" metalness={0.6} /></mesh>
            <mesh position={[x0 - 0.1, 1.1, (CABIN_FRONT - HALF_Z) / 2]}><boxGeometry args={[0.05, 2.2, HALF_Z + CABIN_FRONT]} />{GLASS}</mesh>
            {/* A plant in the corner */}
            <group position={[x1 - 0.45, 0, -HALF_Z + 0.55]}>
              <mesh position={[0, 0.22, 0]} castShadow><cylinderGeometry args={[0.18, 0.14, 0.44, 14]} /><meshStandardMaterial color="#E5E7EB" roughness={0.6} /></mesh>
              <mesh position={[0, 0.75, 0]} castShadow><icosahedronGeometry args={[0.36, 1]} /><meshStandardMaterial color="#2F7D32" roughness={0.9} flatShading /></mesh>
            </group>
          </group>
        )
      })}
      <mesh position={[ROOM.coordinator.x1 + 0.15, 1.1, (COORD_ROOM_FRONT - HALF_Z) / 2]} castShadow>
        <boxGeometry args={[0.05, 2.2, HALF_Z + COORD_ROOM_FRONT]} />{GLASS}
      </mesh>
      <LabSign name={name} />
      <Sign kind="esd" at={[-HALF_X + 0.14, 1.75, -2.4]} rotY={Math.PI / 2} />
      <Sign kind="glasses" at={[-HALF_X + 0.14, 1.75, -0.6]} rotY={Math.PI / 2} />
      <Sign kind="nofood" at={[-HALF_X + 0.14, 1.75, 3.0]} rotY={Math.PI / 2} />
      <FirstAid at={[-HALF_X + 0.2, 1.5, 4.6]} rotY={Math.PI / 2} />
      <Sign kind="fives" at={[-HALF_X + 0.14, 1.7, -6.3]} rotY={Math.PI / 2} w={0.9} />
      {[SPOT.dock[0], SPOT.dispatch[0]].map(x => <Sign key={x} kind="exit" at={[x, 2.25, HALF_Z - 0.16]} rotY={Math.PI} w={0.8} />)}
      <CautionStand at={[12.4, 0, 3.4]} rotY={-0.4} />
    </group>
  )
}

/**
 * The Revive Lab's name over the building: a dark panel on two steel posts
 * on the back wall, the name in white, a Cyrix-red stripe under it; lit from
 * within at night.
 */
function LabSign({ name }: { name: string }) {
  const night = useNight()
  const words = useTextTexture(name.toUpperCase(), { w: 2048, h: 220, color: '#FFFFFF', spacing: 14, size: 0.58 })
  return (
    <group position={[0, 4.55, -HALF_Z - 0.05]}>
      {[-4.6, 4.6].map(x => <mesh key={x} position={[x, -0.7, -0.05]}><boxGeometry args={[0.14, 1.4, 0.14]} />{STEEL}</mesh>)}
      <RoundedBox args={[11, 1.35, 0.22]} radius={0.06} castShadow>
        <meshStandardMaterial color="#0F172A" metalness={0.3} roughness={0.35} />
      </RoundedBox>
      <mesh position={[0, 0.08, 0.115]}>
        <planeGeometry args={[10.4, 1.1]} />
        <meshStandardMaterial map={words} transparent emissiveMap={words} emissive="#FFFFFF" emissiveIntensity={night ? 1.6 : 0.25} toneMapped={false} />
      </mesh>
      <mesh position={[0, -0.56, 0.116]}>
        <planeGeometry args={[10.6, 0.1]} />
        <meshStandardMaterial color="#C0262D" emissive="#C0262D" emissiveIntensity={night ? 2 : 0.3} toneMapped={false} />
      </mesh>
    </group>
  )
}

/**
 * A department's board over its room: brushed-steel edge, a dark face with
 * the name in white, an LED strip in the role's colour along the bottom that
 * glows at night (the user, 8 Oct: "for each cabin, add a dept name board").
 */
function Board({ at, text, color }: { at: V3; text: string; color: string }) {
  const night = useNight()
  const words = useTextTexture(text.toUpperCase(), { w: 1024, h: 160, color: '#F8FAFC', spacing: 10, size: 0.5 })
  return (
    <group position={at}>
      {[-1.05, 1.05].map(x => <mesh key={x} position={[x, 0.55, 0]}><cylinderGeometry args={[0.008, 0.008, 0.9, 6]} /><meshStandardMaterial color="#94A3B8" metalness={0.8} /></mesh>)}
      <RoundedBox args={[2.5, 0.46, 0.07]} radius={0.03} castShadow>
        <meshStandardMaterial color="#9CA3AF" metalness={0.85} roughness={0.3} />
      </RoundedBox>
      <mesh position={[0, 0.02, 0.037]}><planeGeometry args={[2.4, 0.36]} /><meshStandardMaterial color="#111827" roughness={0.4} /></mesh>
      <mesh position={[0, 0.035, 0.039]}>
        <planeGeometry args={[2.3, 0.36]} />
        <meshStandardMaterial map={words} transparent emissiveMap={words} emissive="#FFFFFF" emissiveIntensity={night ? 1.3 : 0.15} toneMapped={false} />
      </mesh>
      <mesh position={[0, -0.17, 0.04]}>
        <planeGeometry args={[2.3, 0.04]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={night ? 2.5 : 0.6} toneMapped={false} />
      </mesh>
    </group>
  )
}

/** An area marked out on the floor: a coloured patch, a hazard edge, its name painted on it. */
function Zone({ at, size, color, label }: { at: V3; size: [number, number]; color: string; label: string }) {
  const words = useTextTexture(label.toUpperCase(), { w: 1024, h: 180, color: 'rgba(31,41,55,0.82)', spacing: 8, size: 0.5 })
  return (
    <group position={at}>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.106, 0]} receiveShadow>
        <planeGeometry args={[size[0] + 0.24, size[1] + 0.24]} />
        <meshStandardMaterial color="#EAB308" roughness={0.7} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.107, 0]} receiveShadow>
        <planeGeometry args={size} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.109, size[1] / 2 - 0.32]}>
        <planeGeometry args={[size[0] * 0.95, size[0] * 0.95 * 180 / 1024]} />
        <meshStandardMaterial map={words} transparent depthWrite={false} />
      </mesh>
    </group>
  )
}

/** A name on the floor, readable on day and night alike. */
function Label({ at, text }: { at: V3; text: string }) {
  return (
    <Html position={at} center style={{ pointerEvents: 'none' }} zIndexRange={[10, 0]}>
      <span className="whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium shadow-sm"
        style={{ background: 'rgba(255,255,255,.92)', color: '#1F2937' }}>{text}</span>
    </Html>
  )
}

/** A desk, a laptop open towards the chair, a chair; the person sits facing the room. */
function Workstation({ at }: { at: V3 }) {
  const night = useNight()
  return (
    <group position={at}>
      <RoundedBox args={[1.5, 0.06, 0.75]} radius={0.02} position={[0, 0.76, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#B98352" roughness={0.55} />
      </RoundedBox>
      <mesh position={[0, 0.38, 0.32]} castShadow><boxGeometry args={[1.42, 0.72, 0.04]} /><meshStandardMaterial color="#9A6A40" roughness={0.6} /></mesh>
      {[-0.68, 0.68].map(x => (
        <mesh key={x} position={[x, 0.38, 0]} castShadow><boxGeometry args={[0.05, 0.74, 0.7]} /><meshStandardMaterial color="#87592F" /></mesh>
      ))}
      <mesh position={[0, 0.8, -0.05]} castShadow><boxGeometry args={[0.46, 0.02, 0.32]} /><meshStandardMaterial color="#9CA3AF" metalness={0.5} roughness={0.35} /></mesh>
      <group position={[0, 0.8, 0.11]} rotation-x={-0.35}>
        <mesh position={[0, 0.16, 0]} castShadow><boxGeometry args={[0.46, 0.31, 0.015]} /><meshStandardMaterial color="#6B7280" metalness={0.5} roughness={0.35} /></mesh>
        <mesh position={[0, 0.16, -0.009]} rotation-y={Math.PI}>
          <planeGeometry args={[0.42, 0.27]} />
          <meshStandardMaterial color="#7FB6E8" emissive="#3B82F6" emissiveIntensity={night ? 1.3 : 0.3} />
        </mesh>
      </group>
      <mesh position={[0.48, 0.8, 0.05]}><cylinderGeometry args={[0.04, 0.035, 0.1, 12]} /><meshStandardMaterial color="#F8FAFC" /></mesh>
      <mesh position={[-0.5, 0.79, 0.05]}><boxGeometry args={[0.22, 0.01, 0.3]} /><meshStandardMaterial color="#F1F5F9" /></mesh>
      <mesh position={[-0.6, 0.86, 0.25]}><cylinderGeometry args={[0.08, 0.06, 0.12, 10]} /><meshStandardMaterial color="#B45309" /></mesh>
      <mesh position={[-0.6, 0.97, 0.25]}><icosahedronGeometry args={[0.1, 0]} /><meshStandardMaterial color="#16A34A" flatShading /></mesh>
      <Chair at={[0, 0, -0.85]} />
    </group>
  )
}

function Chair({ at, rotY = 0 }: { at: V3; rotY?: number }) {
  return (
    <group position={at} rotation-y={rotY}>
      <mesh position={[0, 0.47, 0]} castShadow><boxGeometry args={[0.48, 0.07, 0.46]} /><meshStandardMaterial color="#1F2937" roughness={0.7} /></mesh>
      <mesh position={[0, 0.82, -0.22]} castShadow><boxGeometry args={[0.46, 0.6, 0.06]} /><meshStandardMaterial color="#1F2937" roughness={0.7} /></mesh>
      <mesh position={[0, 0.24, 0]}><cylinderGeometry args={[0.03, 0.03, 0.42, 8]} /><meshStandardMaterial color="#6B7280" metalness={0.6} /></mesh>
      <mesh position={[0, 0.04, 0]}><cylinderGeometry args={[0.26, 0.26, 0.04, 16]} /><meshStandardMaterial color="#374151" /></mesh>
    </group>
  )
}

/** A repair bench, the engineer behind it: an anti-static mat, a soldering station, a lamp, bins. */
function Bench({ at, scale = 1 }: { at: V3; scale?: number }) {
  const night = useNight()
  return (
    <group position={at} scale={scale}>
      <RoundedBox args={[2.5, 0.08, 1.0]} radius={0.02} position={[0, 0.9, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#9AA5B1" roughness={0.45} metalness={0.15} />
      </RoundedBox>
      <mesh position={[0, 0.45, 0.05]} castShadow><boxGeometry args={[2.4, 0.86, 0.85]} /><meshStandardMaterial color="#5F6B7A" roughness={0.6} /></mesh>
      {[-0.8, 0, 0.8].map(x => (
        <mesh key={x} position={[x, 0.55, 0.48]}><boxGeometry args={[0.7, 0.28, 0.02]} /><meshStandardMaterial color="#4B5563" /></mesh>
      ))}
      <mesh position={[0, 0.945, -0.05]} rotation-x={-Math.PI / 2}><planeGeometry args={[1.4, 0.7]} /><meshStandardMaterial color="#2F6F8F" roughness={0.9} /></mesh>
      <mesh position={[0.95, 1.04, 0.2]} castShadow><boxGeometry args={[0.36, 0.22, 0.28]} /><meshStandardMaterial color="#1F2937" /></mesh>
      <mesh position={[0.95, 1.07, 0.341]}><planeGeometry args={[0.2, 0.08]} /><meshStandardMaterial color="#F87171" emissive="#EF4444" emissiveIntensity={night ? 1.6 : 0.6} /></mesh>
      <mesh position={[0.95, 1.0, -0.2]} rotation-z={0.6}><torusGeometry args={[0.06, 0.012, 6, 14]} /><meshStandardMaterial color="#9CA3AF" metalness={0.7} /></mesh>
      <group position={[-1.05, 0.94, 0.35]}>
        <mesh position={[0, 0.3, 0]} rotation-x={-0.4}><cylinderGeometry args={[0.015, 0.015, 0.6, 6]} /><meshStandardMaterial color="#E5E7EB" /></mesh>
        <mesh position={[0, 0.58, -0.18]} rotation-x={-1.2}><cylinderGeometry args={[0.11, 0.11, 0.04, 18]} /><meshStandardMaterial color="#F3F4F6" emissive={night ? '#FFF7D6' : '#000000'} emissiveIntensity={night ? 1.2 : 0} /></mesh>
      </group>
      {[0.55, 0.75].map((x, i) => (
        <mesh key={x} position={[x, 0.98, 0.38]}><boxGeometry args={[0.16, 0.08, 0.12]} /><meshStandardMaterial color={i ? '#F59E0B' : '#3B82F6'} /></mesh>
      ))}
    </group>
  )
}

function Shelf({ at }: { at: V3 }) {
  const colors = ['#E24B4A', '#378ADD', '#EF9F27', '#10B981']
  return (
    <group position={at}>
      {[0.1, 0.85, 1.6, 2.35].map(y => (
        <mesh key={y} position={[0, y, 0]} castShadow receiveShadow><boxGeometry args={[0.9, 0.05, 5]} /><meshStandardMaterial color="#94A3B8" metalness={0.4} roughness={0.5} /></mesh>
      ))}
      {[-2.45, 2.45].map(z => [-0.42, 0.42].map(x => (
        <mesh key={`${x}${z}`} position={[x, 1.2, z]}><boxGeometry args={[0.05, 2.4, 0.05]} /><meshStandardMaterial color="#64748B" metalness={0.5} /></mesh>
      )))}
      {[0.35, 1.1, 1.85].map((y, r) =>
        [-1.85, -0.65, 0.55, 1.75].map((z, c) => (
          <mesh key={`${r}${c}`} position={[0, y, z]} castShadow>
            <boxGeometry args={[0.7, 0.42, 0.9]} />
            <meshStandardMaterial color={colors[(r + c) % 4]} roughness={0.6} />
          </mesh>
        )))}
      <Label at={[0, 2.85, 0]} text="Parts" />
    </group>
  )
}

/* ================================================================ tickets */

/** A packed spare: arriving at the dock, waiting to be assigned, or ready to go back. */
function Parcel({ at, late, mine, onHover, onOpen }: {
  at: V3; late: boolean; mine: boolean
  onHover: (on: boolean) => void; onOpen: () => void
}) {
  return (
    <group position={at}>
      <RoundedBox args={[0.6, 0.5, 0.6]} radius={0.03} castShadow
        onPointerOver={pointer.over(() => onHover(true))} onPointerOut={pointer.out(() => onHover(false))}
        onClick={e => { e.stopPropagation(); document.body.style.cursor = ''; onOpen() }}>
        {/* Past its TAT: the whole box red, as the legend says (the user, 8 Oct: "like earlier add past tat red box") */}
        <meshStandardMaterial color={late ? '#DC2626' : '#C4924F'} roughness={late ? 0.6 : 0.88} emissive={late ? '#7F1D1D' : '#000000'} emissiveIntensity={late ? 0.35 : 0} />
      </RoundedBox>
      <mesh position={[0, 0.252, 0]} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[0.6, 0.12]} />
        <meshStandardMaterial color={late ? '#FCA5A5' : '#D9B27A'} roughness={0.4} />
      </mesh>
      {/* A shipping label on the front; red, for one past its TAT */}
      <mesh position={[0.08, 0.02, 0.302]}>
        <planeGeometry args={[0.26, 0.18]} />
        <meshStandardMaterial color="#F8FAFC" />
      </mesh>
      {[0.06, 0.02, -0.02].map(y => <mesh key={y} position={[0.08, y, 0.303]}><planeGeometry args={[0.2, 0.012]} /><meshStandardMaterial color="#9CA3AF" /></mesh>)}
      {mine && <Marker y={0.62} />}
    </group>
  )
}

function Marker({ y }: { y: number }) {
  const ring = useRef<Mesh>(null)
  useFrame(({ clock }) => { if (ring.current) { ring.current.position.y = y + Math.sin(clock.elapsedTime * 3) * 0.06; ring.current.rotation.y += 0.03 } })
  return (
    <mesh ref={ring} position={[0, y, 0]}>
      <octahedronGeometry args={[0.12]} />
      <meshStandardMaterial color="#FACC15" emissive="#CA8A04" emissiveIntensity={0.6} />
    </mesh>
  )
}

/**
 * The spare on the bench (the user, 8 Oct: "why box in eng table? it should
 * be spare or any parts"). Which part it looks like is chosen from the
 * ticket, so the same ticket always looks the same: a circuit board, a power
 * module, a probe, a display, a battery pack or a pump.
 */
const SPARES = 6
function Spare({ at, scale = 1, kind, late, mine, onHover, onOpen }: {
  at: V3; scale?: number; kind: number; late: boolean; mine: boolean
  onHover: (on: boolean) => void; onOpen: () => void
}) {
  const handlers = {
    onPointerOver: pointer.over(() => onHover(true)),
    onPointerOut: pointer.out(() => onHover(false)),
    onClick: (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); document.body.style.cursor = ''; onOpen() },
  }
  return (
    <group position={at} scale={scale}>
      <group {...handlers}>
        {kind === 0 && (
          <group>
            <mesh castShadow position={[0, 0.02, 0]}><boxGeometry args={[0.46, 0.025, 0.32]} /><meshStandardMaterial color="#166534" roughness={0.5} /></mesh>
            {[[-0.12, -0.06], [0.08, 0.07], [0.14, -0.08]].map(([x, z], i) => (
              <mesh key={i} position={[x, 0.045, z]} castShadow><boxGeometry args={[0.1, 0.025, 0.08]} /><meshStandardMaterial color="#111827" /></mesh>
            ))}
            {[[-0.16, 0.09], [-0.05, 0.1], [0.02, -0.1]].map(([x, z], i) => (
              <mesh key={`c${i}`} position={[x, 0.07, z]}><cylinderGeometry args={[0.022, 0.022, 0.07, 10]} /><meshStandardMaterial color={i === 1 ? '#1D4ED8' : '#374151'} /></mesh>
            ))}
            <mesh position={[0.2, 0.05, 0.1]}><boxGeometry args={[0.05, 0.04, 0.1]} /><meshStandardMaterial color="#F8FAFC" /></mesh>
          </group>
        )}
        {kind === 1 && (
          <group>
            <mesh castShadow position={[0, 0.1, 0]}><boxGeometry args={[0.42, 0.18, 0.3]} /><meshStandardMaterial color="#9CA3AF" metalness={0.6} roughness={0.35} /></mesh>
            {[-0.1, -0.05, 0, 0.05, 0.1].map(x => (
              <mesh key={x} position={[x, 0.191, 0]}><boxGeometry args={[0.02, 0.005, 0.22]} /><meshStandardMaterial color="#374151" /></mesh>
            ))}
            <mesh position={[0, 0.08, 0.155]}><boxGeometry args={[0.24, 0.06, 0.02]} /><meshStandardMaterial color="#15803D" /></mesh>
          </group>
        )}
        {kind === 2 && (
          <group rotation-y={0.4}>
            <mesh castShadow position={[0, 0.06, 0]} rotation-z={Math.PI / 2}><capsuleGeometry args={[0.05, 0.2, 6, 12]} /><meshStandardMaterial color="#D1D5DB" roughness={0.4} /></mesh>
            <mesh position={[0.17, 0.06, 0]} rotation-z={Math.PI / 2}><boxGeometry args={[0.06, 0.12, 0.09]} /><meshStandardMaterial color="#4B5563" /></mesh>
            <mesh position={[-0.24, 0.03, 0.08]} rotation-x={Math.PI / 2}><torusGeometry args={[0.1, 0.012, 6, 20, Math.PI * 1.4]} /><meshStandardMaterial color="#111827" /></mesh>
          </group>
        )}
        {kind === 3 && (
          <group rotation-x={-0.25}>
            <mesh castShadow position={[0, 0.03, 0]}><boxGeometry args={[0.46, 0.03, 0.3]} /><meshStandardMaterial color="#111827" roughness={0.3} /></mesh>
            <mesh position={[0, 0.047, 0]} rotation-x={-Math.PI / 2}><planeGeometry args={[0.42, 0.26]} /><meshStandardMaterial color="#1E3A8A" emissive="#1D4ED8" emissiveIntensity={0.35} /></mesh>
          </group>
        )}
        {kind === 4 && (
          <group>
            <mesh castShadow position={[0, 0.08, 0]}><boxGeometry args={[0.32, 0.15, 0.22]} /><meshStandardMaterial color="#1E3A8A" roughness={0.5} /></mesh>
            <mesh position={[0, 0.08, 0.111]}><planeGeometry args={[0.2, 0.08]} /><meshStandardMaterial color="#FACC15" /></mesh>
            {[-0.07, 0.07].map(x => <mesh key={x} position={[x, 0.17, 0]}><cylinderGeometry args={[0.02, 0.02, 0.03, 8]} /><meshStandardMaterial color={x < 0 ? '#DC2626' : '#111827'} /></mesh>)}
          </group>
        )}
        {kind === 5 && (
          <group>
            <mesh castShadow position={[0, 0.1, 0]} rotation-z={Math.PI / 2}><cylinderGeometry args={[0.09, 0.09, 0.26, 18]} /><meshStandardMaterial color="#CBD5E1" metalness={0.7} roughness={0.25} /></mesh>
            <mesh position={[0.16, 0.1, 0]} rotation-z={Math.PI / 2}><cylinderGeometry args={[0.07, 0.07, 0.07, 16]} /><meshStandardMaterial color="#111827" /></mesh>
            <mesh position={[-0.16, 0.1, 0]} rotation-z={Math.PI / 2}><cylinderGeometry args={[0.02, 0.02, 0.08, 8]} /><meshStandardMaterial color="#9CA3AF" metalness={0.8} /></mesh>
          </group>
        )}
        {/* An easier thing to point at than a thin board */}
        <mesh position={[0, 0.1, 0]} visible={false}><boxGeometry args={[0.55, 0.3, 0.42]} /></mesh>
      </group>
      {late && (
        <mesh position={[0, 0.006, 0]} rotation-x={-Math.PI / 2}>
          <planeGeometry args={[0.56, 0.42]} />
          <meshStandardMaterial color="#DC2626" emissive="#7F1D1D" emissiveIntensity={0.5} />
        </mesh>
      )}
      {mine && <Marker y={0.42} />}
    </group>
  )
}

/* ================================================================ people */

/**
 * How somebody looks, settled by their id so they look the same every time
 * (the user, 8 Oct: "make everyones look unique, hair color etc").
 */
type Look = {
  skin: string; hair: string; style: 'short' | 'side' | 'long' | 'bun' | 'cropped'
  height: number; build: number; glasses: boolean; moustache: boolean
}
/** One skin tone for everybody (the user, 8 Oct: "skin color not needed, make it normal"). */
const SKIN = '#DDA67C'
const HAIRS = ['#0F0F0F', '#1B1411', '#2B1D14', '#3B2416', '#4A3020', '#5C5C5C', '#8A8A8A']
const STYLES: Look['style'][] = ['short', 'side', 'long', 'bun', 'cropped', 'short', 'side']
function lookOf(id: string): Look {
  let h = 2166136261
  for (const c of id) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 }
  const pick = (n: number, shift: number) => ((h >>> shift) % n)
  const style = STYLES[pick(STYLES.length, 3)]
  const long = style === 'long' || style === 'bun'
  return {
    skin: SKIN,
    hair: HAIRS[pick(HAIRS.length, 6)],
    style,
    height: 0.94 + pick(12, 9) / 100,
    build: 0.93 + pick(14, 13) / 100,
    glasses: pick(10, 17) < 3,
    moustache: !long && pick(10, 21) < 4,
  }
}

type R = React.RefObject<Group>
/** The joints that move: shoulders and elbows, hips and knees, the upper body at the waist, the head; and the whole, to sit down. */
type Limbs = {
  root: R; torso: R; head: R
  armL: R; armR: R; elbowL: R; elbowR: R
  legL: R; legR: R; kneeL: R; kneeR: R
}
const useLimbs = (): Limbs => ({
  root: useRef<Group>(null), torso: useRef<Group>(null), head: useRef<Group>(null),
  armL: useRef<Group>(null), armR: useRef<Group>(null), elbowL: useRef<Group>(null), elbowR: useRef<Group>(null),
  legL: useRef<Group>(null), legR: useRef<Group>(null), kneeL: useRef<Group>(null), kneeR: useRef<Group>(null),
})
const turn = (r: R, x: number, z = 0) => { if (r.current) { r.current.rotation.x = x; r.current.rotation.z = z } }
/** Both arms at once: shoulder and elbow, left then right; z swings an arm out from the side. */
function arms(l: Limbs, sl: number, el: number, sr: number, er: number, zl = 0, zr = 0) {
  turn(l.armL, sl, zl); turn(l.elbowL, el); turn(l.armR, sr, zr); turn(l.elbowR, er)
}

/**
 * Shapes shared by every person, made once: a torso turned on a lathe —
 * hips, waist, chest, shoulders — and the hips of the trousers, so a body
 * reads as a body and not a stack of capsules (the user, 8 Oct: "realistic
 * shapes").
 */
let bodyShapes: { torso: LatheGeometry; hips: LatheGeometry } | null = null
function shapes() {
  if (bodyShapes) return bodyShapes
  const pts = (list: Array<[number, number]>) => list.map(([x, y]) => new Vector2(x, y))
  bodyShapes = {
    torso: new LatheGeometry(pts([[0, -0.02], [0.16, -0.01], [0.168, 0.06], [0.152, 0.16], [0.168, 0.28], [0.188, 0.4], [0.198, 0.48], [0.185, 0.55], [0.13, 0.6], [0.07, 0.635], [0, 0.645]]), 28),
    hips: new LatheGeometry(pts([[0, -0.14], [0.13, -0.14], [0.165, -0.07], [0.172, 0.02], [0.166, 0.1], [0, 0.1]]), 24),
  }
  return bodyShapes
}

/** Shows what it holds only while the switch is on: a tool only at the bench, not on the walk there. */
function Gate({ open, children }: { open?: React.MutableRefObject<boolean>; children: React.ReactNode }) {
  const g = useRef<Group>(null)
  useFrame(() => { if (g.current && open) g.current.visible = open.current })
  return <group ref={g}>{children}</group>
}

/**
 * A person at about real size (the user, 8 Oct: "make more 3d realistic"):
 * shoes with soles, trousers and a belt, a shaped uniform shirt in their
 * role's colour with a collar and an ID badge, short sleeves, tapered arms
 * and legs with elbows, knees and hands, a neck, and a head with a jaw, ears
 * and hair of their own. Hips and knees bend to sit and to walk; shoulders
 * and elbows to work, type, carry and talk.
 */
function Body({ color, limbs, tool, look, vest, toolOn, helmet, phoneOn, cupOn }: {
  color: string; limbs: Limbs; tool?: 'iron' | 'meter' | null; look: Look; vest?: boolean
  /** A phone in the right hand, a tea cup in the left — only while in use. */
  phoneOn?: React.MutableRefObject<boolean>; cupOn?: React.MutableRefObject<boolean>
  /** When given, the tool shows only while this is true. */
  toolOn?: React.MutableRefObject<boolean>
  /** A rider's helmet, in this colour. */
  helmet?: string
}) {
  const { torso, hips } = shapes()
  const shirt = <meshStandardMaterial color={color} roughness={0.72} />
  const pants = <meshStandardMaterial color="#232B3E" roughness={0.85} />
  const shoe = <meshStandardMaterial color="#141414" roughness={0.42} metalness={0.1} />
  const skin = <meshStandardMaterial color={look.skin} roughness={0.6} />
  const hair = <meshStandardMaterial color={look.hair} roughness={0.85} />
  const leg = (side: number, legRef: R, kneeRef: R) => (
    <group ref={legRef} position={[side * 0.1, 0.92, 0]}>
      <mesh position={[0, -0.22, 0]} castShadow><cylinderGeometry args={[0.092, 0.07, 0.46, 14]} />{pants}</mesh>
      <group ref={kneeRef} position={[0, -0.45, 0]}>
        <mesh castShadow><sphereGeometry args={[0.07, 12, 10]} />{pants}</mesh>
        <mesh position={[0, -0.21, 0]} castShadow><cylinderGeometry args={[0.068, 0.05, 0.42, 14]} />{pants}</mesh>
        {/* Shoe: an upper rounded at the toe, on a sole */}
        <group position={[0, -0.43, 0.04]}>
          <RoundedBox args={[0.11, 0.075, 0.25]} radius={0.035} castShadow>{shoe}</RoundedBox>
          <mesh position={[0, -0.04, 0.005]}><boxGeometry args={[0.115, 0.018, 0.26]} /><meshStandardMaterial color="#3F3F46" roughness={0.9} /></mesh>
        </group>
      </group>
    </group>
  )
  const arm = (side: number, armRef: R, elbowRef: R, hand?: React.ReactNode) => (
    <group ref={armRef} position={[side * 0.235, 0.6, 0]}>
      <mesh castShadow><sphereGeometry args={[0.072, 14, 12]} />{shirt}</mesh>
      <mesh position={[0, -0.13, 0]} castShadow><cylinderGeometry args={[0.07, 0.056, 0.26, 14]} />{shirt}</mesh>
      <group ref={elbowRef} position={[0, -0.29, 0]}>
        <mesh castShadow><sphereGeometry args={[0.05, 12, 10]} />{skin}</mesh>
        <mesh position={[0, -0.13, 0]} castShadow><cylinderGeometry args={[0.049, 0.038, 0.25, 12]} />{skin}</mesh>
        {/* A hand: a palm and a thumb */}
        <group position={[0, -0.3, 0.008]}>
          <RoundedBox args={[0.068, 0.09, 0.034]} radius={0.015} castShadow>{skin}</RoundedBox>
          <mesh position={[side * -0.035, 0.012, 0.018]} rotation-z={side * 0.6}><capsuleGeometry args={[0.013, 0.035, 4, 8]} />{skin}</mesh>
        </group>
        {hand && <Gate open={toolOn}>{hand}</Gate>}
        {side > 0 && phoneOn && (
          <Gate open={phoneOn}>
            <group position={[-0.02, -0.33, 0.05]} rotation-x={-0.9}>
              <RoundedBox args={[0.075, 0.15, 0.012]} radius={0.008}><meshStandardMaterial color="#111827" metalness={0.5} roughness={0.2} /></RoundedBox>
              <mesh position={[0, 0, 0.0065]}><planeGeometry args={[0.066, 0.135]} /><meshStandardMaterial color="#60A5FA" emissive="#3B82F6" emissiveIntensity={1.2} toneMapped={false} /></mesh>
            </group>
          </Gate>
        )}
        {side < 0 && cupOn && (
          <Gate open={cupOn}>
            <group position={[0.02, -0.34, 0.05]}>
              <mesh><cylinderGeometry args={[0.04, 0.032, 0.09, 14]} /><meshStandardMaterial color="#F8FAFC" roughness={0.35} /></mesh>
              <mesh position={[0, 0.044, 0]} rotation-x={-Math.PI / 2}><circleGeometry args={[0.036, 14]} /><meshStandardMaterial color="#8B5A2B" /></mesh>
            </group>
          </Gate>
        )}
      </group>
    </group>
  )
  return (
    <group scale={[look.build * 0.89, look.height * 0.89, look.build * 0.89]}>
      <group ref={limbs.root}>
        {leg(-1, limbs.legL, limbs.kneeL)}
        {leg(1, limbs.legR, limbs.kneeR)}
        {/* Everything above the waist turns and leans from the hips */}
        <group ref={limbs.torso} position={[0, 0.95, 0]}>
          <mesh geometry={hips} scale={[1.12, 1, 0.78]} castShadow>{pants}</mesh>
          <mesh position={[0, 0.095, 0]} scale={[1.13, 1, 0.8]}><cylinderGeometry args={[0.172, 0.172, 0.04, 24]} /><meshStandardMaterial color="#111827" metalness={0.3} roughness={0.5} /></mesh>
          <mesh position={[0, 0.095, 0.137]}><boxGeometry args={[0.06, 0.034, 0.012]} /><meshStandardMaterial color="#C0A062" metalness={0.85} roughness={0.25} /></mesh>
          <mesh geometry={torso} position={[0, 0.1, 0]} scale={[1.18, 1, 0.72]} castShadow>{shirt}</mesh>
          {vest && [0.3, 0.45].map(y => (
            <mesh key={y} position={[0, y, 0]} scale={[1.2, 1, 0.74]}><cylinderGeometry args={[0.172, 0.172, 0.035, 24]} /><meshStandardMaterial color="#E5E7EB" emissive="#FFFFFF" emissiveIntensity={0.4} metalness={0.6} roughness={0.2} /></mesh>
          ))}
          {/* Collar, the shirt's buttons, an ID badge */}
          <mesh position={[-0.05, 0.66, 0.07]} rotation-z={0.5} rotation-x={-0.3}><boxGeometry args={[0.1, 0.045, 0.025]} />{shirt}</mesh>
          <mesh position={[0.05, 0.66, 0.07]} rotation-z={-0.5} rotation-x={-0.3}><boxGeometry args={[0.1, 0.045, 0.025]} />{shirt}</mesh>
          {[0.56, 0.46, 0.36, 0.26].map(y => <mesh key={y} position={[0, y, 0.137]}><sphereGeometry args={[0.008, 6, 4]} /><meshStandardMaterial color="#F8FAFC" /></mesh>)}
          <mesh position={[0.1, 0.5, 0.135]} rotation-x={-0.12}><boxGeometry args={[0.07, 0.09, 0.008]} /><meshStandardMaterial color="#F8FAFC" /></mesh>
          <mesh position={[0.1, 0.52, 0.14]} rotation-x={-0.12}><planeGeometry args={[0.05, 0.025]} /><meshStandardMaterial color={color} /></mesh>
          <mesh position={[0, 0.72, 0]}><cylinderGeometry args={[0.05, 0.06, 0.12, 14]} />{skin}</mesh>
          {arm(-1, limbs.armL, limbs.elbowL, tool === 'meter'
            ? <mesh position={[0, -0.33, 0.06]}><boxGeometry args={[0.09, 0.03, 0.15]} /><meshStandardMaterial color="#FACC15" /></mesh>
            : null)}
          {arm(1, limbs.armR, limbs.elbowR, tool
            ? (
              <group position={[0, -0.32, 0.06]} rotation-x={Math.PI / 2}>
                <mesh><cylinderGeometry args={[0.022, 0.022, 0.14, 10]} /><meshStandardMaterial color={tool === 'iron' ? '#DC2626' : '#111827'} /></mesh>
                <mesh position={[0, 0.13, 0]}><cylinderGeometry args={[0.008, 0.003, 0.14, 6]} /><meshStandardMaterial color="#D1D5DB" metalness={0.8} roughness={0.2} /></mesh>
              </group>
            )
            : null)}
          <group ref={limbs.head} position={[0, 0.9, 0]}>
            {/* The head: a skull a little taller than wide, a jaw, ears */}
            <mesh scale={[0.95, 1.1, 1.0]} castShadow><sphereGeometry args={[0.15, 30, 24]} />{skin}</mesh>
            <mesh position={[0, -0.075, 0.025]} scale={[0.95, 0.75, 1]}><sphereGeometry args={[0.112, 20, 16]} />{skin}</mesh>
            {[-1, 1].map(s => <mesh key={s} position={[s * 0.143, 0, -0.005]} scale={[0.35, 1, 0.7]}><sphereGeometry args={[0.042, 12, 10]} />{skin}</mesh>)}
            {!helmet && (look.style !== 'cropped'
              ? <mesh position={[0, 0.03, -0.012]} scale={[0.97, 1.1, 1.03]}><sphereGeometry args={[0.158, 30, 24, 0, Math.PI * 2, 0, Math.PI / (look.style === 'side' ? 1.9 : 2.15)]} />{hair}</mesh>
              : <mesh position={[0, 0.06, -0.012]} scale={[0.97, 1.1, 1.03]}><sphereGeometry args={[0.154, 30, 24, 0, Math.PI * 2, 0, Math.PI / 2.8]} />{hair}</mesh>)}
            {!helmet && look.style === 'side' && <mesh position={[0.06, 0.14, 0.08]} rotation-z={-0.5}><capsuleGeometry args={[0.04, 0.11, 4, 8]} />{hair}</mesh>}
            {!helmet && look.style === 'long' && <mesh position={[0, -0.09, -0.09]}><capsuleGeometry args={[0.115, 0.26, 6, 14]} />{hair}</mesh>}
            {!helmet && look.style === 'bun' && <mesh position={[0, 0.1, -0.16]}><sphereGeometry args={[0.075, 14, 10]} />{hair}</mesh>}
            {helmet && (
              <group>
                <mesh position={[0, 0.03, -0.005]} scale={[1, 1.05, 1.08]}><sphereGeometry args={[0.18, 28, 20, 0, Math.PI * 2, 0, Math.PI / 1.75]} /><meshStandardMaterial color={helmet} metalness={0.3} roughness={0.25} /></mesh>
                <mesh position={[0, 0.02, 0.12]} rotation-x={-0.2}><sphereGeometry args={[0.16, 20, 12, -0.9, 1.8, 1.0, 0.75]} /><meshStandardMaterial color="#111827" metalness={0.5} roughness={0.08} transparent opacity={0.85} /></mesh>
              </group>
            )}
            {[-0.052, 0.052].map(x => (
              <group key={x} position={[x, 0.012, 0.13]}>
                <mesh><sphereGeometry args={[0.019, 10, 8]} /><meshStandardMaterial color="#FFFFFF" /></mesh>
                <mesh position={[0, 0, 0.012]}><sphereGeometry args={[0.01, 8, 6]} /><meshStandardMaterial color="#1F2937" /></mesh>
              </group>
            ))}
            {[-0.052, 0.052].map(x => <mesh key={`b${x}`} position={[x, 0.048, 0.138]} rotation-z={x < 0 ? 0.08 : -0.08}><boxGeometry args={[0.045, 0.01, 0.01]} />{hair}</mesh>)}
            <mesh position={[0, -0.02, 0.15]} rotation-x={0.25} scale={[0.8, 1, 1]}><coneGeometry args={[0.024, 0.055, 10]} />{skin}</mesh>
            <mesh position={[0, -0.085, 0.124]}><boxGeometry args={[0.05, 0.011, 0.01]} /><meshStandardMaterial color="#9A4A3C" /></mesh>
            {look.moustache && <mesh position={[0, -0.062, 0.138]}><boxGeometry args={[0.072, 0.017, 0.015]} />{hair}</mesh>}
            {look.glasses && !helmet && (
              <group position={[0, 0.012, 0.15]}>
                {[-0.052, 0.052].map(x => <mesh key={x} position={[x, 0, 0]}><torusGeometry args={[0.029, 0.006, 6, 16]} /><meshStandardMaterial color="#111827" metalness={0.5} /></mesh>)}
                <mesh><boxGeometry args={[0.046, 0.007, 0.007]} /><meshStandardMaterial color="#111827" /></mesh>
              </group>
            )}
          </group>
        </group>
      </group>
      {/* An easy thing to point at, so the name and roles come up on hover (the user, 8 Oct) */}
      <mesh position={[0, 0.95, 0]} visible={false}><boxGeometry args={[0.8, 1.9, 0.7]} /></mesh>
    </group>
  )
}

/** Sitting down or standing up, eased: hips and knees bend, and the body lowers onto the chair. */
function poseSit(l: Limbs, sit: number) {
  if (l.root.current) l.root.current.position.y = -0.43 * sit
  turn(l.legL, -1.5 * sit); turn(l.legR, -1.5 * sit)
  turn(l.kneeL, 1.5 * sit); turn(l.kneeR, 1.5 * sit)
}

/** A step: legs swing from the hips, the back knee bends, arms swing the other way. */
function poseWalk(l: Limbs, stride: number, holding: boolean) {
  const s = Math.sin(stride)
  turn(l.legL, s * 0.48); turn(l.legR, -s * 0.48)
  turn(l.kneeL, Math.max(0, -s) * 0.75); turn(l.kneeR, Math.max(0, s) * 0.75)
  if (holding) arms(l, -0.3, -1.3, -0.3, -1.3, 0.17, -0.17)
  else arms(l, -s * 0.42, -0.25, s * 0.42, -0.25, 0.06, -0.06)
  if (l.torso.current) { l.torso.current.rotation.y = s * 0.06; l.torso.current.rotation.x = 0.03 }
}

/** Standing: legs straight, a little sway. */
function poseStand(l: Limbs, t: number, holding: boolean) {
  turn(l.legL, 0); turn(l.legR, 0); turn(l.kneeL, 0); turn(l.kneeR, 0)
  if (holding) arms(l, -0.3, -1.3, -0.3, -1.3, 0.17, -0.17)
  else arms(l, 0.04 + Math.sin(t * 1.1) * 0.03, -0.12, 0.04 - Math.sin(t * 1.1) * 0.03, -0.12, 0.06, -0.06)
  if (l.torso.current) { l.torso.current.rotation.y = 0; l.torso.current.rotation.x = 0 }
}

/** Typing at the laptop: forearms forward, quick small hand moves, now and then a look up. */
function poseType(l: Limbs, t: number, r: number) {
  const pause = (t * (0.12 + r * 0.05)) % 1 > 0.85
  if (pause) arms(l, -0.15, -0.6, -0.3, -1.3 + Math.sin(t * 2) * 0.2, 0.08, -0.08)
  else arms(l, -0.62, -0.95 + Math.sin(t * 11 + r * 7) * 0.06, -0.62, -0.95 + Math.sin(t * 12.5 + r * 3) * 0.06, 0.1, -0.1)
  if (l.torso.current) { l.torso.current.rotation.x = pause ? -0.05 : 0.14; l.torso.current.rotation.y = 0 }
  if (l.head.current) {
    l.head.current.rotation.x = pause ? -0.1 : 0.18
    l.head.current.rotation.y = pause ? Math.sin(t * 1.2) * 0.35 : Math.sin(t * 0.5 + r) * 0.06
  }
}

/**
 * Picking up or putting down a box: bend at the hips and knees and reach —
 * down to the floor, or forward into a truck — then straighten.
 */
function poseBend(l: Limbs, where: 'low' | 'high', t: number, wait: number) {
  const k = Math.sin(Math.min(1, t / wait) * Math.PI)
  const low = where === 'low'
  turn(l.legL, -0.35 * k * (low ? 1 : 0.3)); turn(l.legR, -0.35 * k * (low ? 1 : 0.3))
  turn(l.kneeL, 0.75 * k * (low ? 1 : 0.3)); turn(l.kneeR, 0.75 * k * (low ? 1 : 0.3))
  if (l.root.current) l.root.current.position.y = -0.18 * k * (low ? 1 : 0.2)
  if (l.torso.current) { l.torso.current.rotation.x = (low ? 0.75 : 0.3) * k; l.torso.current.rotation.y = 0 }
  arms(l, -0.55 - (low ? 0.5 : 0.9) * k, -0.9 + 0.6 * k, -0.55 - (low ? 0.5 : 0.9) * k, -0.9 + 0.6 * k, 0.12, -0.12)
  if (l.head.current) l.head.current.rotation.x = 0.3 * k
}

/** Wiping the bench down in circles with one hand, the other moving the bins straight. */
function poseTidy(l: Limbs, t: number) {
  if (l.torso.current) l.torso.current.rotation.x = 0.28
  arms(l, -0.75 + Math.sin(t * 0.8) * 0.15, -0.7, -0.95 + Math.sin(t * 4) * 0.12, -0.55 + Math.cos(t * 4) * 0.15, 0.1, -0.25 + Math.cos(t * 4) * 0.12)
  if (l.head.current) { l.head.current.rotation.x = 0.45; l.head.current.rotation.y = Math.sin(t * 0.6) * 0.2 }
}

/** Counting stock: clipboard up in the left hand, the right pointing along the shelf, eyes going with it. */
function poseCount(l: Limbs, t: number) {
  const along = Math.sin(t * 0.7)
  arms(l, -0.9, -1.1, -1.2, -0.25, 0.25, -0.3 + along * 0.35)
  if (l.head.current) { l.head.current.rotation.x = -0.1 + Math.abs(along) * 0.15; l.head.current.rotation.y = along * 0.5 }
}

/** On the phone: the phone at the ear, the other hand on the hip, a nod now and then. */
function poseCall(l: Limbs, t: number) {
  arms(l, -0.25, -0.9, -1.25, -2.55, 0.55, -0.55)
  if (l.head.current) { l.head.current.rotation.x = Math.sin(t * 1.3) * 0.08; l.head.current.rotation.y = Math.sin(t * 0.5) * 0.25 - 0.15 }
}

/** A drink of water: cup to the mouth, head back a little, then down again. */
function poseDrink(l: Limbs, t: number) {
  const sip = Math.sin(t * 1.6) > -0.3
  arms(l, -0.1, -0.2, sip ? -1.35 : -0.6, sip ? -2.05 : -1.2, 0.05, -0.45)
  if (l.head.current) { l.head.current.rotation.x = sip ? -0.22 : 0.05; l.head.current.rotation.y = 0 }
}

/** Talking to somebody: a hand that explains, a nod, a glance. */
function poseTalk(l: Limbs, t: number) {
  arms(l, -0.05, -0.2, -0.45 + Math.sin(t * 3.2) * 0.15, -1.1 + Math.sin(t * 2.6) * 0.3, 0.06, -0.15)
  if (l.head.current) { l.head.current.rotation.x = Math.sin(t * 2.4) * 0.08; l.head.current.rotation.y = Math.sin(t * 0.9) * 0.15 }
}

/** Somebody at their desk, working on the laptop (the user, 8 Oct: "working in computer facing this side"). */
function Sitter({ at, color, seed, still, onHover }: {
  at: V3; color: string; seed: string; still: boolean
  onHover: (on: boolean, at: V3) => void
}) {
  const limbs = useLimbs()
  const bubble = useRef<HTMLDivElement>(null)
  const answerFor = useAnswer(seed)
  const look = useMemo(() => lookOf(seed), [seed])
  const r = useMemo(() => seedOf(seed), [seed])
  const p: V3 = [at[0], 0, at[2] - 0.75]
  useStand(seed, p[0], p[2])
  useEffect(() => { poseSit(limbs, 1); poseType(limbs, r * 30, r) }, [limbs, r])
  useFrame(({ clock }) => {
    const say = answerFor(clock.elapsedTime)
    if (bubble.current) {
      bubble.current.style.opacity = say ? '1' : '0'
      if (say && bubble.current.textContent !== say) bubble.current.textContent = say
    }
    if (still) return
    if (say) { poseTalk(limbs, clock.elapsedTime); poseSit(limbs, 1) } else poseType(limbs, clock.elapsedTime + r * 30, r)
  })
  return (
    <group position={p} onPointerOver={pointer.over(() => onHover(true, p))} onPointerOut={pointer.out(() => onHover(false, p))}>
      <Body color={color} limbs={limbs} look={look} />
      <Html position={[0, 1.75, 0]} center style={{ pointerEvents: 'none' }} zIndexRange={[15, 0]}>
        <div ref={bubble} className="whitespace-nowrap rounded-2xl rounded-bl-sm px-2.5 py-1 text-[11px] font-semibold shadow-md transition-opacity duration-300"
          style={{ opacity: 0, background: '#FFFFFF', color: '#111827', border: '1px solid #E5E7EB' }} />
      </Html>
    </group>
  )
}

/**
 * Repairing at the bench (the user, 8 Oct: "make random repairing movements
 * ... some soldering"): hands over the spare, the right one working the iron
 * or the probe, the left steadying it; now and then a reach for the bins, a
 * stretch, or a word with the next bench (the user, 8 Oct: "need engineers
 * and everyone interacting"). Says whether the iron's tip is on the board, for
 * the spark and the smoke.
 */
function poseRepair(l: Limbs, t: number, r: number, neighbour: number): boolean {
  const cycle = (t * (0.07 + r * 0.04)) % 1
  const chat = cycle > 0.52 && cycle <= 0.64
  const stretch = cycle > 0.93
  const reach = cycle > 0.8 && cycle <= 0.93
  turn(l.legL, 0); turn(l.legR, 0); turn(l.kneeL, 0.05); turn(l.kneeR, 0.05)
  const torso = l.torso.current
  if (torso) {
    torso.rotation.y += ((chat ? neighbour * 0.9 : 0) - torso.rotation.y) * 0.06
    torso.rotation.x += ((chat || stretch ? 0 : 0.24) - torso.rotation.x) * 0.1
  }
  if (chat) { poseTalk(l, t); return false }
  const fine = Math.sin(t * (6 + r * 5))
  if (stretch) arms(l, -2.75, -0.3, -2.75, -0.3, 0.15, -0.15)
  else if (reach) arms(l, -0.8, -0.9, -0.95, -0.3, 0.12, -0.55)
  else arms(l, -0.8 + Math.sin(t * 1.4 + r * 4) * 0.06, -0.85, -0.85 + fine * 0.05, -0.75 + Math.sin(t * 1.9) * 0.1, 0.12, -0.18)
  if (l.head.current) {
    l.head.current.rotation.x = stretch ? -0.25 : 0.5 + Math.sin(t * 0.8) * 0.05
    l.head.current.rotation.y = stretch ? 0 : reach ? -0.5 : Math.sin(t * 0.55 + r) * 0.1
  }
  return !stretch && !reach
}

/** The soldering iron's spark and a curl of smoke, where the tip meets the board. */
function SolderFx({ on }: { on: React.MutableRefObject<boolean> }) {
  const spark = useRef<Mesh>(null)
  const s0 = useRef<Mesh>(null), s1 = useRef<Mesh>(null), s2 = useRef<Mesh>(null)
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    if (spark.current) {
      spark.current.visible = on.current && Math.sin(t * 19) > 0.45
      spark.current.scale.setScalar(0.6 + Math.random() * 0.9)
    }
    ;[s0, s1, s2].forEach((s, i) => {
      const m = s.current
      if (!m) return
      m.visible = on.current
      const life = (t * 0.5 + i / 3) % 1
      m.position.set(0.16 + Math.sin(t * 2 + i) * 0.03 * life, 1.0 + life * 0.55, 0.72)
      m.scale.setScalar(0.4 + life * 1.3)
      ;(m.material as MeshStandardMaterial).opacity = 0.35 * (1 - life)
    })
  })
  return (
    <>
      <mesh ref={spark} position={[0.16, 0.99, 0.72]}>
        <sphereGeometry args={[0.03, 8, 6]} />
        <meshStandardMaterial color="#FFF3B0" emissive="#FFD25A" emissiveIntensity={5} toneMapped={false} />
      </mesh>
      {[s0, s1, s2].map((s, i) => (
        <mesh key={i} ref={s}>
          <sphereGeometry args={[0.05, 8, 6]} />
          <meshStandardMaterial color="#E5E7EB" transparent opacity={0.3} depthWrite={false} />
        </mesh>
      ))}
    </>
  )
}

/** An engineer behind the bench, facing the room, repairing the spare in front of them. */
function Engineer({ at, scale = 1, seed, working, neighbour, onHover }: {
  at: V3; scale?: number; seed: string; working: boolean; neighbour: number
  onHover: (on: boolean, at: V3) => void
}) {
  const bubble = useRef<HTMLDivElement>(null)
  const answerFor = useAnswer(seed)
  const limbs = useLimbs()
  const look = useMemo(() => lookOf(seed), [seed])
  const r = useMemo(() => seedOf(seed), [seed])
  const solder = r < 0.55
  const tip = useRef(false)
  const twist = useRef(0)
  useStand(seed, at[0], at[2])
  useFrame(({ clock }) => {
    const t = clock.elapsedTime + r * 40
    if (!working) {
      const answer = answerFor(clock.elapsedTime)
      if (bubble.current) {
        bubble.current.style.opacity = answer ? '1' : '0'
        if (answer && bubble.current.textContent !== answer) bubble.current.textContent = answer
      }
      // Nothing on the bench: tidying up, looking round, a word with the next bench now and then.
      const chat = !!answer || Math.sin(t * 0.21 + r * 9) > 0.7
      poseStand(limbs, t, false)
      twist.current += ((chat ? neighbour * 0.9 : 0) - twist.current) * 0.05
      if (limbs.torso.current) limbs.torso.current.rotation.y = twist.current
      if (chat) poseTalk(limbs, t)
      else {
        arms(limbs, -0.45 + Math.sin(t * 1.1) * 0.12, -0.7, -0.35 - Math.sin(t * 0.9) * 0.12, -0.8, 0.08, -0.08)
        if (limbs.head.current) { limbs.head.current.rotation.y = Math.sin(t * 0.4) * 0.4; limbs.head.current.rotation.x = 0.15 }
      }
      tip.current = false
      return
    }
    // Spoken to: stop, look up, answer; otherwise repair.
    const say = answerFor(clock.elapsedTime)
    if (bubble.current) {
      bubble.current.style.opacity = say ? '1' : '0'
      if (say && bubble.current.textContent !== say) bubble.current.textContent = say
    }
    if (say) { tip.current = false; if (limbs.torso.current) limbs.torso.current.rotation.x *= 0.9; poseTalk(limbs, t); return }
    tip.current = solder && poseRepair(limbs, t, r, neighbour)
  })
  return (
    <group position={at} scale={scale}>
      <group onPointerOver={pointer.over(() => onHover(true, at))} onPointerOut={pointer.out(() => onHover(false, at))}>
        <Body color={UNIFORM.engineer.color} limbs={limbs} look={look} tool={working ? (solder ? 'iron' : 'meter') : null} />
      </group>
      {working && solder && <SolderFx on={tip} />}
      <Html position={[0, 2.25, 0]} center style={{ pointerEvents: 'none' }} zIndexRange={[15, 0]}>
        <div ref={bubble} className="whitespace-nowrap rounded-2xl rounded-bl-sm px-2.5 py-1 text-[11px] font-semibold shadow-md transition-opacity duration-300"
          style={{ opacity: 0, background: '#FFFFFF', color: '#111827', border: '1px solid #E5E7EB' }} />
      </Html>
    </group>
  )
}

/**
 * Somebody on a round: walks between stops along the aisles, eases into each
 * stop, sits where the stop is a chair or works where it is the bench, faces
 * whoever they came to see and says what it is about, and carries a spare or
 * a part when the leg says so.
 */
function Walker({ color, seed, stops, still, scale = 1, tool = null, gate, rest, offset, vest, loopFrom, onHover }: {
  color: string; seed: string; stops: Stop[]; still: boolean; scale?: number; tool?: 'iron' | 'meter' | null
  /** Only while this is open: a loader works while the truck stands at the dock, and waits otherwise. */
  gate?: React.MutableRefObject<{ parked: boolean; soon: boolean }>
  /** A loader's break while no truck is due: from the dock, round, back to the dock. */
  rest?: Stop[]
  /** Seconds into the first wait to start at; the same for two who are to meet. */
  offset?: number
  vest?: boolean
  /** Once at the end, go on from this stop rather than the first: walk somewhere once, then keep at it there. */
  loopFrom?: number
  onHover: (on: boolean, at: V3) => void
}) {
  const g = useRef<Group>(null)
  const after = (i: number) => (i + 1 >= stops.length ? (loopFrom ?? 0) : i + 1)
  /**
   * At a stop to talk to somebody: their answer comes a beat after the
   * question — only if they are there (the user, 9 Oct: "the conversation is
   * happening when no one is there"), within a few steps of the stop.
   * Otherwise a short look, and on.
   */
  const arrive = (at: Stop, now: number) => {
    nobody.current = false
    if (!at.to) return
    const them = crowd?.current.get(at.to)
    const near = !!them && Math.hypot(them.x - at.at[0], them.z - at.at[2]) < 2.9
    if (!near) { nobody.current = true; pause.current = Math.min(pause.current, 1.2) }
    else if (at.answer && talkTo) talkTo.current.set(at.to, { say: at.answer, from: now + (at.wait ?? 3) * 0.5 + 0.15, until: now + (at.wait ?? 3) + 0.3 })
  }
  const limbs = useLimbs()
  const look = useMemo(() => lookOf(seed), [seed])
  const r = useMemo(() => seedOf(seed), [seed])
  const box = useRef<Mesh>(null)
  const part = useRef<Mesh>(null)
  const dropped = useRef<Mesh>(null)
  const droppedFor = useRef(0)
  const bubble = useRef<HTMLDivElement>(null)
  const talkTo = useContext(Talk)
  const crowd = useContext(Crowd)
  const side = useRef(0)
  /** The one to talk to here is not here: nothing is said on this stop. */
  const nobody = useRef(false)
  const across = useRef<[number, number]>([1, 0])
  const answerFor = useAnswer(seed)
  const tip = useRef(false)
  const toolOn = useRef(false)
  const phoneOn = useRef(false)
  const cupOn = useRef(false)
  const seated = useContext(Seated)
  const names = useContext(Names)
  const leg = useRef(0)
  const t = useRef(0)
  const pause = useRef(0)
  const sit = useRef(stops[0]?.sit ? 1 : 0)
  /** At the work (`stops`), on a break (`rest`), or on the way back from it to the dock (`way`). */
  const mode = useRef<'work' | 'rest' | 'back'>('work')
  const way = useRef<Stop[]>([])
  const key = stops.map(x => x.at.join(',') + (x.say ?? '')).join('|')
  useEffect(() => () => { crowd?.current.delete(seed); seated?.current.delete(seed) }, [crowd, seated, seed])
  useEffect(() => {
    leg.current = 0; t.current = 0; mode.current = 'work'
    // Not all at once: each starts somewhere in their first wait.
    pause.current = offset ?? (stops[0]?.wait ?? 1) * (0.25 + r * 0.75)
    if (g.current && stops[0]) g.current.position.set(stops[0].at[0], 0, stops[0].at[2])
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useFrame(({ clock }, dt) => {
    const me = g.current
    if (!me) return
    // A loader (the user, 9 Oct: "they don't have time to drink water or tea, but when the vehicle comes they
    // need to be near the vehicle"): off on a break once the truck has gone, back to the dock as the next is due.
    if (gate && rest && rest.length > 1 && !still) {
      const due = gate.current.parked || gate.current.soon
      if (mode.current === 'work' && !due && leg.current === 0 && pause.current <= 0.05) {
        mode.current = 'rest'; leg.current = 0; t.current = 0; pause.current = rest[0].wait ?? 1
      } else if (mode.current === 'rest' && due) {
        way.current = wayBack(rest, leg.current % rest.length, [me.position.x, 0, me.position.z], stops[0].at)
        mode.current = 'back'; leg.current = 0; t.current = 0; pause.current = 0
      }
    }
    const list = mode.current === 'rest' && rest ? rest : mode.current === 'back' ? way.current : stops
    const next = (i: number) => (mode.current === 'work' ? after(i) : (i + 1) % list.length)
    const from = list[leg.current % list.length], to = list[next(leg.current % list.length)]
    // A loader at the start of a trip waits for the truck.
    if (gate && mode.current === 'work' && !gate.current.parked && leg.current === 0 && pause.current <= 0.05) pause.current = 0.05
    const waiting = pause.current > 0 || still || list.length < 2
    toolOn.current = waiting && (!!from.work || !!from.count)
    const wantSit = waiting && !!from.sit ? 1 : 0
    sit.current += (wantSit - sit.current) * Math.min(1, dt * 6)
    const now = clock.elapsedTime
    // Up from the chair first, then off: nobody walks away half sitting.
    if (!waiting && sit.current > 0.04) {
      poseStand(limbs, now, false)
      poseSit(limbs, sit.current)
      return
    }
    if (!waiting && limbs.root.current) limbs.root.current.position.y = 0
    let carry = waiting ? from.carry : to.carry
    if (waiting && (from.pick || from.put)) {
      const half = (from.wait ?? 1) / 2
      const inHand = from.pick ? pause.current < half : pause.current > half
      carry = inHand ? (from.carry === 'part' ? 'part' : true) : undefined
      // Put down: the box stays where it was set, a while.
      if (from.put && from.carry !== 'part' && !inHand && dropped.current && !dropped.current.visible) {
        const fx = Math.sin(me.rotation.y), fz = Math.cos(me.rotation.y)
        dropped.current.position.set(me.position.x + fx * 0.55, from.put === 'low' ? 0.3 : 1.05, me.position.z + fz * 0.55)
        dropped.current.visible = true
        droppedFor.current = 4
      }
    }
    if (dropped.current?.visible) { droppedFor.current -= dt; if (droppedFor.current <= 0) dropped.current.visible = false }
    if (box.current) box.current.visible = carry === true
    if (part.current) part.current.visible = carry === 'part'
    const holding = !!carry
    const turnTo = (want: number) => {
      let d = want - me.rotation.y
      d = Math.atan2(Math.sin(d), Math.cos(d))
      me.rotation.y += d * Math.min(1, dt * 8)
    }
    // At the pantry table: who else is there decides whether there is talk, and whose turn it is.
    const atPantry = waiting && !!from.pantry && sit.current > 0.6 && !still
    if (seated) { if (atPantry) seated.current.add(seed); else seated.current.delete(seed) }
    let pantryLine = '', doing: 'phone' | 'tea' | 'talk' | 'listen' = 'phone'
    if (atPantry) {
      const there = seated ? [...seated.current].sort() : [seed]
      const chatting = there.length > 1 && (now % 34) < 15
      const turn = Math.floor(now / 3.6)
      if (chatting) {
        const mine = there[turn % there.length] === seed
        doing = mine ? 'talk' : 'listen'
        if (mine && (now % 3.6) < 3.1) {
          const line = SMALL_TALK[(turn * 7 + Math.floor(now / 34)) % SMALL_TALK.length]
          const other = names?.get(there[(turn + 1) % there.length]) ?? ''
          pantryLine = other && turn % 2 === 0 ? `${other}, ${line[0].toLowerCase()}${line.slice(1)}` : line
        }
      } else doing = ((now + r * 50) % 26) < 9 ? 'tea' : 'phone'
    }
    phoneOn.current = (atPantry && doing === 'phone') || (waiting && (!!from.call || !!from.phone) && !still)
    cupOn.current = (atPantry && doing === 'tea') || (waiting && !!from.drink && !still)
    // What is being said, over their head, while they say it.
    const asking = waiting && from.say && !still && !(from.to && nobody.current) && (!from.answer || pause.current > (from.wait ?? 3) * 0.5)
    const saying = (asking ? from.say! : '') || answerFor(now) || pantryLine
    if (bubble.current) {
      bubble.current.style.opacity = saying ? '1' : '0'
      if (saying && bubble.current.textContent !== saying) bubble.current.textContent = saying
    }
    tip.current = false
    if (waiting) {
      if (from.sit) turnTo(from.face ?? 0)
      else if (from.face !== undefined) turnTo(from.face)
      if (atPantry) {
        if (doing === 'phone') posePhone(limbs, now + r * 9)
        else if (doing === 'tea') poseDrink(limbs, now + r * 5)
        else if (doing === 'talk') poseTalk(limbs, now)
        else { arms(limbs, -0.5, -1.2, -0.45, -1.3, 0.15, -0.15); if (limbs.head.current) { limbs.head.current.rotation.x = 0.05; limbs.head.current.rotation.y = Math.sin(now * 0.7 + r) * 0.4 } }
      }
      else if (sit.current > 0.6 && !still) poseType(limbs, now + r * 30, r)
      else if (from.work && !still) tip.current = tool === 'iron' && poseRepair(limbs, now + r * 40, r, 1)
      else if ((from.pick || from.put) && !still) poseBend(limbs, from.pick ?? from.put!, (from.wait ?? 1) - pause.current, from.wait ?? 1)
      else if (from.drink && !still) { poseStand(limbs, now, false); poseDrink(limbs, now) }
      else if (from.call && !still) { poseStand(limbs, now, false); poseCall(limbs, now) }
      else if (from.tidy && !still) { poseStand(limbs, now, false); poseTidy(limbs, now + r * 7) }
      else if (from.count && !still) { poseStand(limbs, now, false); poseCount(limbs, now + r * 5) }
      else if (from.phone && !still) { poseStand(limbs, now, false); posePhone(limbs, now + r * 9) }
      else if (from.talk && !still) { poseStand(limbs, now, false); poseTalk(limbs, now) }
      else { poseStand(limbs, now, holding); if (limbs.head.current) limbs.head.current.rotation.x = 0.25 }
      if (sit.current > 0.01) poseSit(limbs, sit.current)
      if (!still && list.length >= 2) pause.current -= dt
      me.position.y += (0 - me.position.y) * 0.2
      // Back onto the spot from any sidestep, and stand there.
      side.current *= 1 - Math.min(1, dt * 3)
      me.position.x = from.at[0] + across.current[0] * side.current
      me.position.z = from.at[2] + across.current[1] * side.current
      crowd?.current.set(seed, { x: me.position.x, z: me.position.z, moving: false })
      return
    }
    if (limbs.head.current) { limbs.head.current.rotation.x = 0; limbs.head.current.rotation.y = 0 }
    const len = Math.max(0.01, Math.hypot(to.at[0] - from.at[0], to.at[2] - from.at[2]))
    /** On to the next stop; back at the dock from a break, the loader waits there for the truck. */
    const onward = () => {
      leg.current = next(leg.current); t.current = 0; pause.current = to.wait ?? 0; arrive(to, now)
      if (mode.current === 'back' && leg.current >= list.length - 1) { mode.current = 'work'; leg.current = 0; pause.current = 0.05 }
    }
    if (len < 0.02) { onward(); return }
    const dx = (to.at[0] - from.at[0]) / len, dz = (to.at[2] - from.at[2]) / len
    across.current = [-dz, dx]
    // Somebody close and straight ahead who is also walking: the one with the later name waits a moment.
    let blocked = false, push = 0
    if (crowd) {
      for (const [id, o] of crowd.current) {
        if (id === seed) continue
        const ox = o.x - me.position.x, oz = o.z - me.position.z
        const d = Math.hypot(ox, oz)
        if (d > 1.3 || d < 1e-3) continue
        const ahead = (ox * dx + oz * dz) / d
        if (d < 0.75 && ahead > 0.6 && o.moving && id < seed) blocked = true
        // Step to whichever side they are not on, more the closer they are.
        if (ahead > -0.2) {
          const lateral = ox * -dz + oz * dx
          push += -(lateral >= 0 ? 1 : -1) * (1.3 - d) * 0.75
        }
      }
    }
    side.current += (Math.max(-0.5, Math.min(0.5, push)) - side.current) * Math.min(1, dt * 4)
    if (!blocked) t.current += (dt * 1.35) / len
    const u = Math.min(1, t.current)
    // Eases only into and out of a stop; through a corner they keep walking.
    const k = from.wait && to.wait ? smooth(u) : from.wait ? u * u : to.wait ? 1 - (1 - u) * (1 - u) : u
    me.position.x = from.at[0] + (to.at[0] - from.at[0]) * k + across.current[0] * side.current
    me.position.z = from.at[2] + (to.at[2] - from.at[2]) * k + across.current[1] * side.current
    crowd?.current.set(seed, { x: me.position.x, z: me.position.z, moving: !blocked })
    const stride = t.current * len * 4.4
    me.position.y = Math.abs(Math.sin(stride)) * 0.04
    poseWalk(limbs, stride, holding)
    if (sit.current > 0.01) poseSit(limbs, sit.current)
    if (len > 0.05) turnTo(Math.atan2(to.at[0] - from.at[0], to.at[2] - from.at[2]))
    if (t.current >= 1) onward()
  })
  const start = stops[0].at
  return (
    <>
    <mesh ref={dropped} visible={false} castShadow>
      <boxGeometry args={[0.44, 0.34, 0.38]} />
      <meshStandardMaterial color="#C4924F" roughness={0.88} />
    </mesh>
    <group ref={g} position={start}
      onPointerOver={pointer.over(() => { const p = g.current!.position; onHover(true, [p.x, 0, p.z]) })}
      onPointerOut={pointer.out(() => onHover(false, start))}>
      <group scale={scale}>
        <Body color={color} limbs={limbs} look={look} tool={tool} vest={vest} toolOn={toolOn} phoneOn={phoneOn} cupOn={cupOn} />
        <mesh ref={box} position={[0, 1.07, 0.37]} visible={false} castShadow>
          <boxGeometry args={[0.44, 0.34, 0.38]} />
          <meshStandardMaterial color="#C98F45" roughness={0.85} />
        </mesh>
        <mesh ref={part} position={[0, 1.1, 0.35]} visible={false} castShadow>
          <boxGeometry args={[0.26, 0.16, 0.2]} />
          <meshStandardMaterial color="#2563EB" roughness={0.6} />
        </mesh>
        {tool === 'iron' && <SolderFx on={tip} />}
      </group>
      <Html position={[0, 2.25 * scale, 0]} center style={{ pointerEvents: 'none' }} zIndexRange={[15, 0]}>
        <div ref={bubble} className="whitespace-nowrap rounded-2xl rounded-bl-sm px-2.5 py-1 text-[11px] font-semibold shadow-md transition-opacity duration-300"
          style={{ opacity: 0, background: '#FFFFFF', color: '#111827', border: '1px solid #E5E7EB' }} />
      </Html>
    </group>
    </>
  )
}

/* ================================================================ the pantry */

/**
 * A pantry corner (the user, 9 Oct: "engineers without work can go and sit
 * there, drinking tea, scrolling phone, if more than 1, random talking ...
 * human nature"): a table with four chairs, a tea counter with a kettle, cups
 * and a microwave along the wall, a fridge, a rug, its own board.
 */
const PANTRY_DOOR_X = (ROOM.pantry.x0 + ROOM.pantry.x1) / 2
const PANTRY_HALL_Z = -6.05
const PANTRY_TABLE: V3 = [PANTRY_DOOR_X, 0, -7.3]
const PANTRY_CHAIRS: Array<{ at: V3; face: number; via: V3[] }> = [
  { at: [PANTRY_DOOR_X - 0.75, 0, -6.95], face: Math.PI / 2, via: [[PANTRY_DOOR_X - 0.75, 0, PANTRY_HALL_Z]] },
  { at: [PANTRY_DOOR_X + 0.75, 0, -6.95], face: -Math.PI / 2, via: [[PANTRY_DOOR_X + 0.75, 0, PANTRY_HALL_Z]] },
  { at: [PANTRY_DOOR_X - 0.75, 0, -7.65], face: Math.PI / 2, via: [[PANTRY_DOOR_X - 1.4, 0, PANTRY_HALL_Z], [PANTRY_DOOR_X - 1.4, 0, -8.4], [PANTRY_DOOR_X - 0.75, 0, -8.4]] },
  { at: [PANTRY_DOOR_X + 0.75, 0, -7.65], face: -Math.PI / 2, via: [[PANTRY_DOOR_X + 1.4, 0, PANTRY_HALL_Z], [PANTRY_DOOR_X + 1.4, 0, -8.4], [PANTRY_DOOR_X + 0.75, 0, -8.4]] },
]
/** Into the pantry from the back corridor: through its door to the space inside it. */
const PANTRY_IN: V3[] = [[PANTRY_DOOR_X, 0, BACK_CORRIDOR], [PANTRY_DOOR_X, 0, CABIN_FRONT + 0.2], [PANTRY_DOOR_X, 0, PANTRY_HALL_Z]]

function Pantry() {
  const wood = <meshStandardMaterial color="#A36A3D" roughness={0.5} />
  const white = <meshStandardMaterial color="#F1F5F9" roughness={0.35} />
  return (
    <group>
      {/* Rug */}
      <mesh rotation-x={-Math.PI / 2} position={[PANTRY_TABLE[0], 0.106, PANTRY_TABLE[2]]} receiveShadow>
        <planeGeometry args={[3.2, 2.7]} />
        <meshStandardMaterial color="#8C5A3C" roughness={0.95} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[PANTRY_TABLE[0], 0.107, PANTRY_TABLE[2]]}>
        <planeGeometry args={[2.9, 2.4]} />
        <meshStandardMaterial color="#B98A5E" roughness={0.95} />
      </mesh>
      {/* Table and chairs */}
      <group position={PANTRY_TABLE}>
        <RoundedBox args={[0.8, 0.05, 1.4]} radius={0.02} position={[0, 0.74, 0]} castShadow receiveShadow>{wood}</RoundedBox>
        {[[-0.32, -0.6], [0.32, -0.6], [-0.32, 0.6], [0.32, 0.6]].map(([x, z]) => (
          <mesh key={`${x}${z}`} position={[x, 0.36, z]} castShadow><cylinderGeometry args={[0.025, 0.025, 0.72, 8]} /><meshStandardMaterial color="#374151" metalness={0.6} /></mesh>
        ))}
        {/* A plate of biscuits and a newspaper on the table */}
        <mesh position={[0, 0.775, -0.1]}><cylinderGeometry args={[0.13, 0.11, 0.02, 20]} />{white}</mesh>
        {[0, 1, 2, 3].map(k => <mesh key={k} position={[Math.cos(k * 1.6) * 0.06, 0.79, -0.1 + Math.sin(k * 1.6) * 0.06]}><cylinderGeometry args={[0.035, 0.035, 0.012, 12]} /><meshStandardMaterial color="#D4A253" /></mesh>)}
        <mesh position={[0.05, 0.768, 0.35]} rotation-y={0.3}><boxGeometry args={[0.3, 0.008, 0.42]} /><meshStandardMaterial color="#E5E7EB" /></mesh>
      </group>
      {PANTRY_CHAIRS.map((c, i) => <Chair key={i} at={c.at} rotY={c.face} />)}
      {/* The tea counter along the wall: cabinets, a top, a kettle, cups, a microwave, a sugar jar */}
      <group position={[ROOM.pantry.x0 + 1.75, 0, -HALF_Z + 0.45]} rotation-y={-Math.PI / 2}>
        <mesh position={[0, 0.44, 0]} castShadow receiveShadow><boxGeometry args={[0.6, 0.88, 2.8]} /><meshStandardMaterial color="#334155" roughness={0.6} /></mesh>
        {[-0.95, -0.3, 0.35, 1.0].map(z => <mesh key={z} position={[0.302, 0.5, z]}><boxGeometry args={[0.01, 0.6, 0.55]} /><meshStandardMaterial color="#475569" /></mesh>)}
        <mesh position={[0, 0.9, 0]} castShadow><boxGeometry args={[0.64, 0.04, 2.84]} /><meshStandardMaterial color="#E5E7EB" roughness={0.25} /></mesh>
        <group position={[0.05, 0.92, -0.9]}>
          <mesh position={[0, 0.11, 0]} castShadow><cylinderGeometry args={[0.08, 0.1, 0.22, 16]} /><meshStandardMaterial color="#9CA3AF" metalness={0.85} roughness={0.2} /></mesh>
          <mesh position={[0, 0.02, 0]}><cylinderGeometry args={[0.11, 0.11, 0.04, 16]} /><meshStandardMaterial color="#111827" /></mesh>
          <mesh position={[0.1, 0.14, 0]} rotation-z={Math.PI / 2}><torusGeometry args={[0.05, 0.012, 6, 12, Math.PI]} /><meshStandardMaterial color="#111827" /></mesh>
        </group>
        {[-0.4, -0.28, -0.16].map(z => <mesh key={z} position={[0.08, 0.96, z]}><cylinderGeometry args={[0.035, 0.028, 0.08, 12]} />{white}</mesh>)}
        <mesh position={[0.08, 0.98, 0.05]}><cylinderGeometry args={[0.05, 0.05, 0.12, 12]} /><meshPhysicalMaterial color="#F8FAFC" transparent opacity={0.6} roughness={0.05} /></mesh>
        <RoundedBox args={[0.42, 0.28, 0.5]} radius={0.02} position={[0, 1.06, 0.75]} castShadow><meshStandardMaterial color="#1F2937" roughness={0.4} /></RoundedBox>
        <mesh position={[0.212, 1.06, 0.7]}><planeGeometry args={[0.01, 0.01]} /><meshStandardMaterial color="#000" /></mesh>
        <mesh position={[0.211, 1.06, 0.68]} rotation-y={Math.PI / 2}><planeGeometry args={[0.3, 0.18]} /><meshStandardMaterial color="#0F172A" metalness={0.5} roughness={0.1} /></mesh>
      </group>
      {/* Fridge */}
      <group position={[ROOM.pantry.x1 - 0.45, 0, -HALF_Z + 0.5]} rotation-y={-Math.PI / 2}>
        <RoundedBox args={[0.65, 1.8, 0.65]} radius={0.04} position={[0, 0.9, 0]} castShadow receiveShadow><meshStandardMaterial color="#CBD5E1" metalness={0.6} roughness={0.25} /></RoundedBox>
        <mesh position={[0.33, 1.25, 0.2]}><boxGeometry args={[0.03, 0.4, 0.03]} /><meshStandardMaterial color="#64748B" metalness={0.8} /></mesh>
        <mesh position={[0.331, 1.05, 0]}><boxGeometry args={[0.002, 0.01, 0.6]} /><meshStandardMaterial color="#94A3B8" /></mesh>
      </group>
      {/* A plant by the table */}
      <group position={[ROOM.pantry.x0 + 0.45, 0, CABIN_FRONT - 0.45]}>
        <mesh position={[0, 0.22, 0]} castShadow><cylinderGeometry args={[0.2, 0.15, 0.44, 14]} /><meshStandardMaterial color="#E5E7EB" roughness={0.6} /></mesh>
        <mesh position={[0, 0.8, 0]} castShadow><icosahedronGeometry args={[0.42, 1]} /><meshStandardMaterial color="#2F7D32" roughness={0.9} flatShading /></mesh>
      </group>
      <Board at={[PANTRY_DOOR_X, 2.55, CABIN_FRONT]} text="Pantry" color="#0EA5E9" />
      <WaterCooler />
    </group>
  )
}

/** Small talk at the pantry table: one says something, then the next, never two at once. */
const SMALL_TALK = [
  'Did you see the match last night?', 'Lunch at 1?', 'Tea is too sweet today', 'Rain again, traffic was bad',
  'My bench is empty for once!', 'Any new tickets coming?', 'Weekend plans?', 'This phone needs charging',
  'Who took my cup?', 'Canteen has biriyani today', 'Battery at 5%', 'Long day…',
]

/** Everybody's first name, so they can call each other by it. */
const Names = createContext<Map<string, string> | null>(null)

/** Who is sitting at the pantry table just now, so they take turns to talk. */
const Seated = createContext<React.MutableRefObject<Set<string>> | null>(null)

/** Looking at the phone: both hands up holding it, head down, a thumb scrolling. */
function posePhone(l: Limbs, t: number) {
  arms(l, -0.45, -1.5 + Math.sin(t * 9) * 0.03, -0.4, -1.55, 0.2, -0.2)
  if (l.head.current) { l.head.current.rotation.x = 0.45; l.head.current.rotation.y = Math.sin(t * 0.3) * 0.05 }
  if (l.torso.current) l.torso.current.rotation.x = 0.08
}

/**
 * From an empty bench to the pantry (the user, 9 Oct): stand at the bench a
 * little, then round the end of the row, along the left aisle, to a chair at
 * the table — from its side, never through the table — for a long sit.
 */
function pantryRound(home: V3, behindZ: number, chair: { at: V3; face: number; via: V3[] }, i: number): Stop[] {
  // Along the gap behind the row to the right aisle, up to the back corridor, in through the pantry's door, round to the chair —
  // and there they stay until something is assigned (the user, 9 Oct: "let them sit there in pantry until something is assigned").
  const way: Stop[] = [{ at: [RIGHT_AISLE, 0, behindZ] }, { at: [RIGHT_AISLE, 0, BACK_CORRIDOR] }, ...PANTRY_IN.map(at => ({ at })), ...chair.via.map(at => ({ at }))]
  return [
    { at: home, wait: 2 + (i % 4) * 2, face: 0 },
    { at: [home[0], 0, behindZ] },
    ...way,
    { at: chair.at, wait: 30, sit: true, face: chair.face, pantry: true },
  ]
}

/**
 * A loader's time between trucks (the user, 9 Oct: "vehicles are coming very
 * fast, they don't have time to drink water or tea"): along the front and up
 * the right aisle to the pantry, tea at the counter — a word with the other
 * loader if they are there too — back to the dock, a call to the driver, the
 * phone; round again until the truck is due (see `wayBack`).
 */
function loaderBreak(side: 'in' | 'out', mate: string): Stop[] {
  const left = side === 'in'
  const x = (left ? SPOT.dock[0] : SPOT.dispatch[0]) - 2.2
  const dock: V3 = [x, 0, 8.9]
  const road = -Math.PI / 2
  // Round the table on their own side of it, to their own end of the counter.
  const round = left ? PANTRY_DOOR_X - 1.4 : PANTRY_DOOR_X + 1.4
  const cup: V3 = [PANTRY_DOOR_X + (left ? -0.5 : 0.5), 0, -8.35]
  const out: Stop[] = [
    { at: [x - 0.9, 0, 8.95] }, { at: [x - 0.9, 0, FRONT_CORRIDOR] }, { at: [RIGHT_AISLE, 0, FRONT_CORRIDOR] }, { at: [RIGHT_AISLE, 0, BACK_CORRIDOR] },
    ...PANTRY_IN.map(at => ({ at })), { at: [round, 0, PANTRY_HALL_Z] }, { at: [round, 0, -8.4] }, { at: cup },
  ]
  const toOther = left ? Math.PI / 2 : -Math.PI / 2
  const tea: Stop[] = left ? [
    { at: cup, wait: 4, face: Math.PI },
    { at: cup, wait: 9, face: 0, drink: true },
    { at: cup, wait: 6, face: toOther, talk: true, say: `${mate}, your truck coming soon?`, to: 'loader-out', answer: 'After this chai!' },
    { at: cup, wait: 8, face: 0, drink: true },
    { at: cup, wait: 6, face: toOther, talk: true, say: 'Hot today, no?', to: 'loader-out', answer: 'Drink water, it helps' },
  ] : [
    { at: cup, wait: 4, face: Math.PI },
    { at: cup, wait: 12, face: 0, drink: true },
    { at: cup, wait: 21, face: toOther, drink: true },
  ]
  const call: Stop[] = left ? [
    { at: dock, wait: 6, face: road, call: true, say: 'Hello, where is the truck now?' },
    { at: dock, wait: 5, face: road, call: true, say: 'OK, I am at the dock' },
  ] : [
    { at: dock, wait: 6, face: road, call: true, say: 'Hello, what time is the pickup?' },
    { at: dock, wait: 5, face: road, call: true, say: 'OK, the boxes will be ready' },
  ]
  return [
    { at: dock, wait: 3, face: road },
    ...out, ...tea, ...[...out].reverse().slice(1), { at: dock },
    ...call,
    { at: dock, wait: 18, face: road, phone: true },
    { at: dock, wait: 5, face: road },
  ]
}

/**
 * The truck is due: the shorter way back to the dock from wherever on their
 * break a loader is — back the way they came, or on round to its end.
 */
function wayBack(round: Stop[], i: number, here: V3, dock: V3): Stop[] {
  const length = (ps: V3[]) => ps.reduce((sum, p, k) => (k ? sum + Math.hypot(p[0] - ps[k - 1][0], p[2] - ps[k - 1][2]) : 0), 0)
  const back = [here, ...round.slice(0, i + 1).reverse().map(s => s.at), dock]
  const on = [here, ...round.slice(i + 1).map(s => s.at), dock]
  return (length(back) <= length(on) ? back : on).map(at => ({ at }))
}

/** What a free engineer and a loader talk about, waiting on the next truck. */
function loaderTalk(dockSide: boolean, n: number, mate = 'Bhai', me = ''): Array<[string, string]> {
  const you = me ? `, ${me}` : ''
  return dockSide
    ? [[`${mate}, heavy load today?`, n ? `${n} box${n === 1 ? '' : 'es'} came in today${you}` : `Nothing yet today${you}`], ['Truck was late again?', `Traffic at the junction${you}`], [`Had lunch, ${mate.toLowerCase()}?`, 'Not yet — after this truck']]
    : [[`${mate}, how many going back?`, n ? `${n} going back today${you}` : `None to send yet${you}`], ['Tea after this?', `Yes${you}, once it leaves`], ['Rain again tomorrow?', 'Hope not — the roads get flooded']]
}

/**
 * A free engineer at the dock with the loader (the user, 9 Oct: "let them
 * casually talk with loaders"): along the corridor to the dock and round the
 * pile, then a chat in turns — and again, until there is work.
 */
function loaderRound(home: V3, behindZ: number, loader: string, dockX: number, lines: Array<[string, string]>, i: number): Stop[] {
  const x = dockX - 3.1, spot: V3 = [x, 0, 8.95]
  const aisle = dockX < 0 ? LEFT_AISLE : RIGHT_AISLE
  return [
    { at: home, wait: 3 + (i % 3) * 2, face: 0 },
    { at: [home[0], 0, behindZ] }, { at: [aisle, 0, behindZ] }, { at: [aisle, 0, FRONT_CORRIDOR] }, { at: [x, 0, FRONT_CORRIDOR] }, { at: spot },
    ...lines.map(([say, answer]) => ({ at: spot, wait: 5.5, face: Math.PI / 2, talk: true, say, to: loader, answer })),
    { at: spot, wait: 8, face: Math.PI / 2 },
  ]
}

/**
 * Off to help whoever is busiest (the user, 9 Oct: "if you have any idea,
 * add more things what eng can do when they are free"): to the aisle in front
 * of their bench, an offer, their answer, then a while watching and helping.
 */
function helpRound(home: V3, behindZ: number, at: { x: number; z: number; who: string; code: string; late: boolean }, i: number): Stop[] {
  const aisle = at.x < home[0] ? LEFT_AISLE : RIGHT_AISLE
  const spot: V3 = [at.x + 0.75, 0, at.z]
  return [
    { at: home, wait: 3 + (i % 3) * 2, face: 0 },
    { at: [home[0], 0, behindZ] }, { at: [aisle, 0, behindZ] }, { at: [aisle, 0, at.z] }, { at: spot },
    { at: spot, wait: 5.5, face: Math.PI, talk: true, say: `Need a hand with ${at.code}?`, to: at.who, answer: at.late ? 'Yes please — it\'s overdue' : 'Sure, hold this board' },
    { at: spot, wait: 9, face: Math.PI * 1.08, tidy: true },
    { at: spot, wait: 5, face: Math.PI, talk: true, say: 'Try the other capacitor', to: at.who, answer: 'Good idea, thanks!' },
    { at: spot, wait: 9, face: Math.PI * 0.95, tidy: true },
  ]
}

/** 5S at their own empty bench: wiping it down, putting the bins straight. */
function tidyRound(home: V3, i: number): Stop[] {
  return [{ at: home, wait: 2 + (i % 3), face: 0 }, { at: home, wait: 12, face: 0, tidy: true }, { at: home, wait: 4, face: 0.3 }]
}

/** A stock check at the parts shelf, clipboard in hand. */
function countRound(home: V3, behindZ: number, i: number): Stop[] {
  const x = SPOT.shelf[0] - 1.05
  const a: V3 = [x, 0, SPOT.shelf[2] - 1.5], b: V3 = [x, 0, SPOT.shelf[2] + 1.3]
  return [
    { at: home, wait: 3 + (i % 3) * 2, face: 0 },
    { at: [home[0], 0, behindZ] }, { at: [RIGHT_AISLE, 0, behindZ] }, { at: [RIGHT_AISLE, 0, a[2]] }, { at: a },
    { at: a, wait: 8, face: Math.PI / 2, count: true },
    { at: b, wait: 8, face: Math.PI / 2, count: true },
  ]
}

/**
 * A free engineer's time, round and round until a spare is assigned (the
 * user, 9 Oct: "whole time he shouldn't be there"): out to one thing, back to
 * the bench to see whether anything has come, out to the next. Each thing is
 * the way there, a spell of it, and the way back.
 */
type FreeKind = 'pantry' | 'loader-in' | 'loader-out' | 'call-right' | 'call-left' | 'help' | 'tidy' | 'count' | 'ask'
function freeDay(home: V3, behindZ: number, order: FreeKind[], i: number, ctx: {
  chair: { at: V3; face: number; via: V3[] }
  loaderLines: { in: Array<[string, string]>; out: Array<[string, string]> }
  help: { x: number; z: number; who: string; code: string; late: boolean; name?: string } | null
  /** The coordinator to ask for work: their desk, who they are, what they will say. */
  ask: { seat: V3; who: string; answer: string; name?: string } | null
  /** This engineer's first name, for the answers. */
  me?: string
}): Stop[] {
  const behind: Stop = { at: [home[0], 0, behindZ] }
  const there = (out: Stop[], stay: Stop[]): Stop[] => [behind, ...out, ...stay, ...[...out].slice(0, -1).reverse(), behind]
  const seg = (k: FreeKind): Stop[] => {
    if (k === 'tidy') return [{ at: home, wait: 14, face: 0, tidy: true }]
    if (k === 'pantry') {
      const out: Stop[] = [{ at: [RIGHT_AISLE, 0, behindZ] }, { at: [RIGHT_AISLE, 0, BACK_CORRIDOR] }, ...PANTRY_IN.map(at => ({ at })), ...ctx.chair.via.map(at => ({ at })), { at: ctx.chair.at }]
      return there(out, [{ at: ctx.chair.at, wait: 40 + (i % 3) * 12, sit: true, face: ctx.chair.face, pantry: true }])
    }
    if (k === 'loader-in' || k === 'loader-out') {
      const dockX = k === 'loader-in' ? SPOT.dock[0] : SPOT.dispatch[0]
      const x = dockX - 3.1, spot: V3 = [x, 0, 8.95]
      const aisle = dockX < 0 ? LEFT_AISLE : RIGHT_AISLE
      const lines = k === 'loader-in' ? ctx.loaderLines.in : ctx.loaderLines.out
      const out: Stop[] = [{ at: [aisle, 0, behindZ] }, { at: [aisle, 0, FRONT_CORRIDOR] }, { at: [x, 0, FRONT_CORRIDOR] }, { at: spot }]
      return there(out, lines.map(([say, answer]) => ({ at: spot, wait: 5.5, face: Math.PI / 2, talk: true, say, to: k, answer })))
    }
    if (k === 'call-right' || k === 'call-left') {
      const right = k === 'call-right', sx = right ? 1 : -1
      const aisle = right ? RIGHT_AISLE : LEFT_AISLE
      const a: V3 = [sx * 18.0, 0, 9.0], b: V3 = [sx * 18.0, 0, 7.6]
      const out: Stop[] = [{ at: [aisle, 0, behindZ] }, { at: [aisle, 0, FRONT_CORRIDOR] }, { at: [sx * 14.9, 0, FRONT_CORRIDOR] }, { at: [sx * 14.9, 0, 9.9] }, { at: [sx * 17.4, 0, 10.0] }, { at: a }]
      return there(out, [
        { at: a, wait: 6, face: right ? Math.PI * 0.8 : -Math.PI * 0.8, call: true, say: CALLS[i % CALLS.length] },
        { at: b, wait: 6, face: right ? -Math.PI / 2 : Math.PI / 2, call: true, say: CALLS[(i + 1) % CALLS.length] },
        { at: a, wait: 5, face: Math.PI, call: true },
      ])
    }
    if (k === 'help' && ctx.help) {
      const h = ctx.help
      const aisle = h.x < home[0] ? LEFT_AISLE : RIGHT_AISLE
      const spot: V3 = [h.x + 0.75, 0, h.z]
      const out: Stop[] = [{ at: [aisle, 0, behindZ] }, { at: [aisle, 0, h.z] }, { at: spot }]
      return there(out, [
        { at: spot, wait: 5.5, face: Math.PI, talk: true, say: `${h.name ? h.name + ', n' : 'N'}eed a hand with ${h.code}?`, to: h.who, answer: h.late ? `Yes please${ctx.me ? ' ' + ctx.me : ''} — it's overdue` : `Sure${ctx.me ? ' ' + ctx.me : ''}, hold this board` },
        { at: spot, wait: 9, face: Math.PI * 1.08, tidy: true },
        { at: spot, wait: 5, face: Math.PI, talk: true, say: 'Try the other capacitor', to: h.who, answer: `Good idea${ctx.me ? ', ' + ctx.me : ''}, thanks!` },
      ])
    }
    if (k === 'ask' && ctx.ask) {
      // To the coordinator: is there anything for me? (the user, 9 Oct)
      const c = toCoordinator(ctx.ask.seat, [LEFT_AISLE, 0, behindZ], { at: [0, 0, 0], wait: 5, face: Math.PI, talk: true, say: `${ctx.ask.name ? 'Hey ' + ctx.ask.name + ', a' : 'A'}nything to assign to me?`, to: ctx.ask.who, answer: ctx.ask.answer })
      return [behind, ...c.go, ...c.back.slice(0, -1), { at: [LEFT_AISLE, 0, behindZ] }, behind]
    }
    if (k === 'count') {
      const x = SPOT.shelf[0] - 1.05
      const a: V3 = [x, 0, SPOT.shelf[2] - 1.5], b: V3 = [x, 0, SPOT.shelf[2] + 1.3]
      const out: Stop[] = [{ at: [RIGHT_AISLE, 0, behindZ] }, { at: [RIGHT_AISLE, 0, a[2]] }, { at: a }]
      return there(out, [{ at: a, wait: 8, face: Math.PI / 2, count: true }, { at: b, wait: 8, face: Math.PI / 2, count: true }, { at: a }])
    }
    return [{ at: home, wait: 12, face: 0, tidy: true }]
  }
  const day: Stop[] = []
  order.forEach((k, n) => { day.push({ at: home, wait: n === 0 ? 2 + (i % 3) * 2 : 4, face: 0 }, ...seg(k)) })
  return day
}

/** On the phone to somebody outside, in a free moment (the user, 9 Oct: "talking to someone through phone"). */
const CALLS = ['Hello? Yes, free now', 'Amma, I\'ll call you back', 'Reaching home by 7', 'Tell him I\'ll check tomorrow', 'Ok, ok — sending the photo', 'No, no overtime today']

/** Out through the dock opening onto the lawn, pacing up and down with the phone, until there is work. */
function callRound(home: V3, behindZ: number, right: boolean, i: number): Stop[] {
  const sx = right ? 1 : -1
  const aisle = right ? RIGHT_AISLE : LEFT_AISLE
  const gate: V3 = [sx * 14.9, 0, 9.9]
  const a: V3 = [sx * 18.0, 0, 9.0], b: V3 = [sx * 18.0, 0, 7.6]
  const line = (k: number) => CALLS[(i + k) % CALLS.length]
  return [
    { at: home, wait: 3 + (i % 3) * 2, face: 0 },
    { at: [home[0], 0, behindZ] }, { at: [aisle, 0, behindZ] }, { at: [aisle, 0, FRONT_CORRIDOR] }, { at: [sx * 14.9, 0, FRONT_CORRIDOR] },
    { at: gate }, { at: [sx * 17.4, 0, 10.0] }, { at: a },
    { at: a, wait: 6, face: right ? Math.PI * 0.8 : -Math.PI * 0.8, call: true, say: line(0) },
    { at: b, wait: 6, face: right ? -Math.PI / 2 : Math.PI / 2, call: true, say: line(1) },
    { at: a, wait: 5, face: right ? Math.PI : Math.PI, call: true },
  ]
}

/* ================================================================ safety signs and the water cooler */

type SignKind = 'esd' | 'glasses' | 'nofood' | 'voltage' | 'firstaid' | 'exit' | 'fives'

/**
 * Signs a repair floor really has (the user, 8 Oct: "in empty walls add
 * hazard warning, precaution, ie something logical"): drawn once onto a
 * texture in the standard colours — yellow triangles warn, blue circles
 * instruct, red circles forbid, green means safety.
 */
function useSignTexture(kind: SignKind) {
  return useMemo(() => {
    const W = 512, H = kind === 'exit' ? 200 : kind === 'fives' ? 420 : 640
    const c = document.createElement('canvas')
    c.width = W; c.height = H
    const g = c.getContext('2d')!
    const font = (px: number, w = 800) => `${w} ${px}px Inter, "Segoe UI", system-ui, sans-serif`
    const words = (lines: string[], y: number, px: number, colour: string) => {
      g.fillStyle = colour; g.font = font(px); g.textAlign = 'center'; g.textBaseline = 'middle'
      lines.forEach((l, i) => g.fillText(l, W / 2, y + i * px * 1.18))
    }
    const panel = (bg: string, border: string) => {
      g.fillStyle = bg; g.fillRect(0, 0, W, H)
      g.strokeStyle = border; g.lineWidth = 14; g.strokeRect(7, 7, W - 14, H - 14)
    }
    const triangle = (draw: () => void) => {
      g.beginPath(); g.moveTo(W / 2, 50); g.lineTo(W / 2 + 175, 345); g.lineTo(W / 2 - 175, 345); g.closePath()
      g.fillStyle = '#FACC15'; g.fill(); g.lineWidth = 22; g.strokeStyle = '#111827'; g.lineJoin = 'round'; g.stroke()
      g.fillStyle = '#111827'; g.strokeStyle = '#111827'
      draw()
    }
    if (kind === 'esd') {
      panel('#FFFFFF', '#FACC15')
      triangle(() => {
        // A hand with a line through it: do not touch without a wrist strap.
        g.lineWidth = 14; g.lineCap = 'round'
        g.beginPath(); g.moveTo(W / 2 - 40, 300); g.lineTo(W / 2 - 40, 200); g.stroke()
        for (let k = 0; k < 4; k++) { g.beginPath(); g.moveTo(W / 2 - 30 + k * 26, 230); g.lineTo(W / 2 - 30 + k * 26, 165 - (k % 3) * 8); g.stroke() }
        g.beginPath(); g.moveTo(W / 2 - 95, 160); g.lineTo(W / 2 + 95, 315); g.stroke()
      })
      words(['ESD PROTECTED', 'AREA', 'Wear your wrist strap'], 420, 52, '#111827')
    }
    if (kind === 'voltage') {
      panel('#FFFFFF', '#FACC15')
      triangle(() => {
        g.beginPath(); g.moveTo(W / 2 + 20, 130); g.lineTo(W / 2 - 50, 245); g.lineTo(W / 2 + 5, 245); g.lineTo(W / 2 - 25, 325)
        g.lineTo(W / 2 + 55, 205); g.lineTo(W / 2 + 2, 205); g.lineTo(W / 2 + 45, 130); g.closePath(); g.fill()
      })
      words(['CAUTION', 'HIGH VOLTAGE', 'Testing in progress'], 420, 52, '#111827')
    }
    if (kind === 'glasses') {
      panel('#FFFFFF', '#1D4ED8')
      g.fillStyle = '#1D4ED8'; g.beginPath(); g.arc(W / 2, 200, 150, 0, Math.PI * 2); g.fill()
      g.strokeStyle = '#FFFFFF'; g.lineWidth = 16
      g.beginPath(); g.ellipse(W / 2 - 58, 205, 48, 36, 0, 0, Math.PI * 2); g.stroke()
      g.beginPath(); g.ellipse(W / 2 + 58, 205, 48, 36, 0, 0, Math.PI * 2); g.stroke()
      g.beginPath(); g.moveTo(W / 2 - 12, 198); g.lineTo(W / 2 + 12, 198); g.stroke()
      words(['WEAR SAFETY', 'GLASSES', 'while soldering'], 420, 52, '#1D4ED8')
    }
    if (kind === 'nofood') {
      panel('#FFFFFF', '#DC2626')
      g.fillStyle = '#111827'
      g.beginPath(); g.moveTo(W / 2 - 50, 140); g.lineTo(W / 2 + 50, 140); g.lineTo(W / 2 + 38, 270); g.lineTo(W / 2 - 38, 270); g.closePath(); g.fill()
      g.strokeStyle = '#DC2626'; g.lineWidth = 26
      g.beginPath(); g.arc(W / 2, 205, 140, 0, Math.PI * 2); g.stroke()
      g.beginPath(); g.moveTo(W / 2 - 99, 106); g.lineTo(W / 2 + 99, 304); g.stroke()
      words(['NO FOOD OR DRINK', 'AT THE BENCHES', 'Water cooler is there'], 420, 46, '#111827')
    }
    if (kind === 'firstaid') {
      panel('#15803D', '#FFFFFF')
      g.fillStyle = '#FFFFFF'; g.fillRect(W / 2 - 40, 90, 80, 230); g.fillRect(W / 2 - 115, 165, 230, 80)
      words(['FIRST AID'], 450, 64, '#FFFFFF')
    }
    if (kind === 'exit') {
      panel('#15803D', '#FFFFFF')
      words(['FIRE EXIT  →'], 100, 72, '#FFFFFF')
    }
    if (kind === 'fives') {
      panel('#F8FAFC', '#334155')
      words(['5S'], 60, 64, '#C0262D')
      g.font = font(34, 600); g.textAlign = 'left'; g.fillStyle = '#1F2937'
      ;['1  Sort — keep only what you need', '2  Set in order — a place for each', '3  Shine — clean the bench daily', '4  Standardise — same way, every bench', '5  Sustain — make it a habit'].forEach((l, i) => g.fillText(l, 40, 150 + i * 52))
    }
    const t = new CanvasTexture(c)
    t.colorSpace = SRGBColorSpace
    t.anisotropy = 8
    return t
  }, [kind])
}

/** A sign on a wall: the printed face on a thin board. */
function Sign({ kind, at, rotY = 0, w = 0.6 }: { kind: SignKind; at: V3; rotY?: number; w?: number }) {
  const night = useNight()
  const tex = useSignTexture(kind)
  const h = w * (kind === 'exit' ? 200 : kind === 'fives' ? 420 : 640) / 512
  return (
    <group position={at} rotation-y={rotY}>
      <mesh castShadow><boxGeometry args={[w + 0.03, h + 0.03, 0.02]} /><meshStandardMaterial color="#E5E7EB" /></mesh>
      <mesh position={[0, 0, 0.012]}>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial map={tex} roughness={0.5}
          emissiveMap={kind === 'exit' ? tex : null} emissive={kind === 'exit' ? '#FFFFFF' : '#000000'} emissiveIntensity={kind === 'exit' ? (night ? 1.5 : 0.4) : 0} toneMapped={kind !== 'exit'} />
      </mesh>
    </group>
  )
}

/** A first-aid box on the wall. */
function FirstAid({ at, rotY = 0 }: { at: V3; rotY?: number }) {
  const tex = useSignTexture('firstaid')
  return (
    <group position={at} rotation-y={rotY}>
      <RoundedBox args={[0.5, 0.42, 0.16]} radius={0.03} castShadow><meshStandardMaterial color="#F8FAFC" roughness={0.4} /></RoundedBox>
      <mesh position={[0, 0, 0.082]}><planeGeometry args={[0.42, 0.34]} /><meshStandardMaterial map={tex} /></mesh>
    </group>
  )
}

/** A caution stand by the bench rows. */
function CautionStand({ at, rotY = 0 }: { at: V3; rotY?: number }) {
  const tex = useSignTexture('voltage')
  return (
    <group position={at} rotation-y={rotY}>
      {[-1, 1].map(s => (
        <group key={s} rotation-x={s * 0.18}>
          <mesh position={[0, 0.48, s * 0.09]} castShadow><boxGeometry args={[0.46, 0.92, 0.02]} /><meshStandardMaterial color="#FACC15" /></mesh>
          <mesh position={[0, 0.5, s * 0.101]} rotation-y={s < 0 ? Math.PI : 0}><planeGeometry args={[0.4, 0.5]} /><meshStandardMaterial map={tex} /></mesh>
        </group>
      ))}
    </group>
  )
}

/** The water cooler: a blue bottle upside down on a white stand, a stack of cups. */
const COOLER: V3 = [ROOM.pantry.x1 - 0.35, 0, -6.3]
function WaterCooler() {
  return (
    <group position={COOLER} rotation-y={Math.PI}>
      <RoundedBox args={[0.46, 1.05, 0.42]} radius={0.04} position={[0, 0.53, 0]} castShadow receiveShadow><meshStandardMaterial color="#F1F5F9" roughness={0.35} /></RoundedBox>
      <mesh position={[0.235, 0.82, -0.08]}><boxGeometry args={[0.02, 0.06, 0.04]} /><meshStandardMaterial color="#2563EB" /></mesh>
      <mesh position={[0.235, 0.82, 0.08]}><boxGeometry args={[0.02, 0.06, 0.04]} /><meshStandardMaterial color="#DC2626" /></mesh>
      <mesh position={[0.2, 0.6, 0]}><boxGeometry args={[0.1, 0.02, 0.3]} /><meshStandardMaterial color="#94A3B8" /></mesh>
      <mesh position={[0, 1.33, 0]} castShadow><cylinderGeometry args={[0.16, 0.16, 0.48, 20]} /><meshPhysicalMaterial color="#60A5FA" transparent opacity={0.65} roughness={0.05} transmission={0.4} thickness={0.3} /></mesh>
      <mesh position={[0, 1.08, 0]}><cylinderGeometry args={[0.05, 0.05, 0.08, 12]} /><meshStandardMaterial color="#3B82F6" /></mesh>
      <mesh position={[0.05, 1.12, 0.3]}><cylinderGeometry args={[0.045, 0.035, 0.24, 12]} /><meshStandardMaterial color="#F8FAFC" /></mesh>
    </group>
  )
}

/* ================================================================ outside */

/**
 * What is on the east-bound lane besides the traffic: the trucks, while they
 * are on the road. Traffic keeps its distance from them and from each other
 * (the user, 8 Oct: "vehicles are overlapping").
 */
/** Something on the road: where, how long, whether it takes up the east-bound lane, and whether it is a truck. */
type Obstacle = { x: number; len: number; onLane: boolean; truck?: boolean }
const Road = createContext<React.MutableRefObject<Record<string, Obstacle>> | null>(null)
const EAST_LANE = ROAD_Z - 1.4
const WEST_LANE = ROAD_Z + 1.4

/** A truck's way: along the road, easing off it onto the apron at its dock, and back onto it. */
function truckZ(x: number, stopX: number, arriving: boolean): number {
  const d = arriving ? stopX - x : x - stopX
  return APRON_Z + (EAST_LANE - APRON_Z) * smooth(d / 9)
}

/**
 * A truck's day, over and over while there is work for it: in along the road
 * and onto the apron at its dock, standing there while the loader works, then
 * off the apron and away (the user, 8 Oct: "from truck let loader loads").
 */
function Truck({ id, stop, body, label, active, dock, first, gap, lead }: {
  id: string; stop: number; body: string; label: string; active: boolean
  /** Parked: the loader works. Soon: it is due, and the loader comes back to the dock for it. */
  dock: React.MutableRefObject<{ parked: boolean; soon: boolean }>
  /** Seconds to the first truck; seconds between one leaving and the next (the user, 9 Oct: "vehicles are coming very fast"). */
  first: number; gap: [number, number]
  /** How long before it is due its loader starts back to the dock. */
  lead: number
}) {
  const g = useRef<Group>(null)
  const road = useContext(Road)
  const red = body !== '#F5F5F4'
  const words = useTextTexture(label, { w: 1024, h: 200, color: red ? '#FFFFFF' : '#C0262D', weight: 900, spacing: 24, size: 0.6 })
  const START = -62, END = 72, LEN = 6.6
  // Where it is in its day: off the road, coming in, standing at the dock, going away.
  const st = useRef<{ phase: 'gone' | 'in' | 'park' | 'out'; x: number; v: number; timer: number }>({ phase: 'gone', x: START, v: 0, timer: first })
  useFrame((_, dt) => {
    const me = g.current
    if (!me) return
    const step = Math.min(dt, 0.05)
    const t = st.current
    const cars = road ? Object.entries(road.current).filter(([k, o]) => k !== id && !o.truck && o.onLane).map(([, o]) => o) : []
    /** Room to the nearest car ahead in the lane. */
    const gapAhead = (x: number) => cars.reduce((m, o) => (o.x > x ? Math.min(m, o.x - x - (o.len + LEN) / 2) : m), Infinity)
    /** Nothing in the lane between these two points. */
    const clear = (a: number, b: number) => !cars.some(o => o.x + o.len / 2 > a && o.x - o.len / 2 < b)
    if (t.phase === 'gone') {
      me.visible = false
      dock.current.parked = false
      t.timer -= step
      dock.current.soon = active && t.timer <= lead
      if (road) road.current[id] = { x: 1e4, len: LEN, onLane: false, truck: true }
      // Onto the road at its far end only when that stretch is empty.
      if (active && t.timer <= 0 && clear(START - 12, START + 20)) { t.phase = 'in'; t.x = START; t.v = 6 }
      return
    }
    me.visible = true
    let z = APRON_Z, ahead = APRON_Z
    if (t.phase === 'in') {
      // Brake for the dock; keep a distance to whatever is ahead while still in the lane.
      const toStop = stop - t.x
      const onRoad = toStop > 5
      let want = Math.min(8, Math.sqrt(Math.max(0, 2 * 1.6 * toStop)))
      if (onRoad) want = Math.min(want, Math.max(0, (gapAhead(t.x) - 4) * 1.1))
      t.v += (want - t.v) * Math.min(1, step * 2)
      t.x = Math.min(stop, t.x + t.v * step)
      z = truckZ(t.x, stop, true); ahead = truckZ(t.x + 0.5, stop, true)
      if (stop - t.x < 0.03) { t.phase = 'park'; t.timer = 40; t.v = 0 }
    } else if (t.phase === 'park') {
      t.timer -= step
      // Out only when nothing is coming along the lane behind or just ahead.
      if (t.timer <= 0 && (!active || clear(stop - 24, stop + 14))) { t.phase = 'out'; t.v = 0 }
    } else if (t.phase === 'out') {
      const want = Math.min(8.5, Math.max(0, (gapAhead(t.x) - 4) * 1.1))
      t.v += (want - t.v) * Math.min(1, step * (want < t.v ? 3 : 0.8))
      t.x += t.v * step
      z = truckZ(t.x, stop, false); ahead = truckZ(t.x + 0.5, stop, false)
      if (t.x > END) { t.phase = 'gone'; t.timer = gap[0] + Math.random() * (gap[1] - gap[0]) }
    }
    dock.current.parked = t.phase === 'park' && t.timer > 1
    dock.current.soon = t.phase === 'in' || dock.current.parked
    me.position.set(t.x, 0, z)
    me.rotation.y = Math.atan2(-(ahead - z), 0.5)
    // Anything of the truck in the lane counts: half its width and half a car's.
    if (road) road.current[id] = { x: t.x, len: LEN, onLane: Math.abs(z - EAST_LANE) < 2.1, truck: true }
  })
  return (
    <group ref={g} position={[stop, 0, APRON_Z]} visible={false}>
      <TruckBody red={red} words={words} />
    </group>
  )
}

/* ---------------------------------------------------------------- vehicle shapes */

/**
 * Vehicles are drawn the way they are designed: a side profile — bonnet,
 * windscreen, roof, boot, wheel arches cut into it — made solid across the
 * width with rounded edges; glass, lights, grille, bumpers and mirrors on
 * top (the user, 8 Oct: "realistic shapes ... truck, car, all things").
 */
function profileSolid(draw: (s: Shape) => void, width: number, bevel = 0.06) {
  const s = new Shape()
  draw(s)
  const depth = Math.max(0.01, width - bevel * 2)
  const g = new ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 20, steps: 1 })
  g.translate(0, 0, -depth / 2)
  g.computeVertexNormals()
  return g
}

/** Along the bottom from the back to the front, arching over each wheel. */
function underside(s: Shape, back: number, front: number, y: number, wheels: number[], r: number) {
  s.moveTo(back, y)
  for (const x of [...wheels].sort((a, b) => a - b)) { s.lineTo(x - r, y); s.absarc(x, y, r, Math.PI, 0, true) }
  s.lineTo(front, y)
}

/** A flat piece of glass (or anything flat) from a side-profile polygon, laid on both flanks. */
function flankGeometry(points: Array<[number, number]>) {
  const s = new Shape(points.map(([x, y]) => new Vector2(x, y)))
  return new ShapeGeometry(s)
}

/** A sheet between two points of the profile, across the width: a windscreen or a rear window, standing just proud of the body. */
function Pane({ a, b, width, out = 0.075, material }: { a: [number, number]; b: [number, number]; width: number; out?: number; material: React.ReactNode }) {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  let nx = -dy / len, ny = dx / len
  // Outward: away from the body's middle, which is below and behind the glass.
  if (ny < 0) { nx = -nx; ny = -ny }
  const cx = (a[0] + b[0]) / 2 + nx * out, cy = (a[1] + b[1]) / 2 + ny * out
  const angle = Math.atan2(ny, nx)
  return (
    <group position={[cx, cy, 0]} rotation-z={angle}>
      <mesh rotation-y={Math.PI / 2}><planeGeometry args={[width, len]} />{material}</mesh>
    </group>
  )
}

const GLASS_DARK = <meshStandardMaterial color="#33506B" metalness={0.6} roughness={0.05} envMapIntensity={1.9} side={DoubleSide} polygonOffset polygonOffsetFactor={-2} />
/** A windscreen: lighter, so it reads as glass against the paint, in a black rubber surround. */
const WINDSCREEN = <meshStandardMaterial color="#5E7A96" metalness={0.55} roughness={0.04} envMapIntensity={2} side={DoubleSide} />
const CHROME = <meshStandardMaterial color="#D1D5DB" metalness={0.95} roughness={0.15} />
const TRIM = <meshStandardMaterial color="#1F2937" roughness={0.6} />

type CarModel = {
  draw: (s: Shape) => void; width: number; wheels: number[]; r: number
  windows: Array<Array<[number, number]>>
  front: [[number, number], [number, number]]; rear?: [[number, number], [number, number]]
  nose: number; tail: number; lampY: number; tailY: number; mirrorX: number; mirrorY: number
}

const MODELS: Record<'car' | 'hatch' | 'van', CarModel> = {
  car: {
    width: 1.78, wheels: [-1.38, 1.38], r: 0.33, nose: 2.27, tail: -2.27, lampY: 0.7, tailY: 0.8, mirrorX: 1.05, mirrorY: 1.04,
    draw: s => {
      underside(s, -2.22, 2.2, 0.3, [-1.38, 1.38], 0.4)
      s.lineTo(2.27, 0.55); s.quadraticCurveTo(2.29, 0.79, 2.05, 0.85); s.lineTo(1.2, 0.98)
      s.quadraticCurveTo(0.9, 1.22, 0.5, 1.4); s.quadraticCurveTo(-0.12, 1.47, -0.76, 1.4)
      s.quadraticCurveTo(-1.15, 1.2, -1.5, 1.0); s.lineTo(-2.05, 0.95); s.quadraticCurveTo(-2.29, 0.9, -2.27, 0.6); s.lineTo(-2.22, 0.3)
    },
    windows: [[[1.1, 1.0], [0.52, 1.35], [-0.08, 1.38], [-0.08, 1.0]], [[-0.18, 1.0], [-0.18, 1.38], [-0.72, 1.35], [-1.35, 1.03]]],
    front: [[1.2, 0.98], [0.52, 1.38]], rear: [[-0.78, 1.39], [-1.47, 1.01]],
  },
  hatch: {
    width: 1.72, wheels: [-1.2, 1.2], r: 0.31, nose: 1.98, tail: -1.98, lampY: 0.7, tailY: 0.95, mirrorX: 0.95, mirrorY: 1.04,
    draw: s => {
      underside(s, -1.95, 1.92, 0.3, [-1.2, 1.2], 0.38)
      s.lineTo(1.98, 0.55); s.quadraticCurveTo(1.99, 0.79, 1.8, 0.86); s.lineTo(1.05, 0.98)
      s.quadraticCurveTo(0.75, 1.26, 0.35, 1.47); s.lineTo(-1.35, 1.47)
      s.quadraticCurveTo(-1.76, 1.43, -1.92, 1.15); s.lineTo(-1.98, 0.6); s.lineTo(-1.95, 0.3)
    },
    windows: [[[0.98, 1.0], [0.4, 1.41], [-0.25, 1.42], [-0.25, 1.0]], [[-0.35, 1.0], [-0.35, 1.42], [-1.3, 1.42], [-1.62, 1.05]]],
    front: [[1.05, 0.98], [0.4, 1.44]], rear: [[-1.4, 1.46], [-1.89, 1.17]],
  },
  van: {
    width: 1.7, wheels: [-1.35, 1.35], r: 0.33, nose: 2.13, tail: -2.13, lampY: 0.78, tailY: 1.0, mirrorX: 1.55, mirrorY: 1.25,
    draw: s => {
      underside(s, -2.1, 2.05, 0.32, [-1.35, 1.35], 0.4)
      s.lineTo(2.12, 0.6); s.quadraticCurveTo(2.15, 0.96, 1.85, 1.05); s.lineTo(1.6, 1.12)
      s.quadraticCurveTo(1.45, 1.6, 1.3, 1.88); s.lineTo(-1.95, 1.92)
      s.quadraticCurveTo(-2.14, 1.9, -2.13, 1.6); s.lineTo(-2.12, 0.32)
    },
    windows: [[[1.46, 1.22], [1.33, 1.76], [0.6, 1.79], [0.6, 1.22]], [[0.5, 1.22], [0.5, 1.79], [-0.65, 1.79], [-0.65, 1.22]], [[-0.75, 1.22], [-0.75, 1.79], [-1.85, 1.79], [-1.85, 1.22]]],
    front: [[1.6, 1.13], [1.31, 1.87]],
  },
}

function useCarGeometry(kind: 'car' | 'hatch' | 'van') {
  return useMemo(() => {
    const m = MODELS[kind]
    return { body: profileSolid(m.draw, m.width), windows: m.windows.map(flankGeometry) }
  }, [kind])
}

/** Head and tail lights, glowing at night. */
function CarLights({ front, back, y, tailY, w }: { front: number; back: number; y: number; tailY: number; w: number }) {
  const night = useNight()
  return (
    <>
      {[-w, w].map(z => (
        <group key={z}>
          <RoundedBox args={[0.06, 0.12, 0.3]} radius={0.02} position={[front, y, z]}>
            <meshStandardMaterial color="#F8FAFC" emissive="#FFF1B8" emissiveIntensity={night ? 4 : 0.15} toneMapped={false} metalness={0.4} roughness={0.1} />
          </RoundedBox>
          <RoundedBox args={[0.06, 0.1, 0.28]} radius={0.02} position={[back, tailY, z]}>
            <meshStandardMaterial color="#991B1B" emissive="#EF4444" emissiveIntensity={night ? 2.5 : 0.3} toneMapped={false} />
          </RoundedBox>
        </group>
      ))}
    </>
  )
}

function Car({ kind, colour }: { kind: 'car' | 'hatch' | 'van'; colour: string }) {
  const m = MODELS[kind]
  const geo = useCarGeometry(kind)
  const half = m.width / 2
  return (
    <group>
      <mesh geometry={geo.body} castShadow receiveShadow>
        <meshPhysicalMaterial color={colour} metalness={0.6} roughness={0.28} clearcoat={1} clearcoatRoughness={0.08} />
      </mesh>
      {geo.windows.map((g, i) => [1, -1].map(s => (
        <mesh key={`${i}${s}`} geometry={g} position={[0, 0, s * (half + 0.014)]} rotation-y={s < 0 ? Math.PI : 0} scale={[s < 0 ? -1 : 1, 1, 1]}>{GLASS_DARK}</mesh>
      )))}
      <Pane a={m.front[0]} b={m.front[1]} width={m.width - 0.2} out={0.085} material={WINDSCREEN} />
      {m.rear && <Pane a={m.rear[0]} b={m.rear[1]} width={m.width - 0.24} material={GLASS_DARK} />}
      {/* Bumpers, grille, number plates, mirrors */}
      <RoundedBox args={[0.18, 0.2, m.width + 0.02]} radius={0.06} position={[m.nose - 0.02, 0.38, 0]} castShadow>{TRIM}</RoundedBox>
      <RoundedBox args={[0.18, 0.2, m.width + 0.02]} radius={0.06} position={[m.tail + 0.02, 0.38, 0]} castShadow>{TRIM}</RoundedBox>
      <mesh position={[m.nose + 0.04, 0.55, 0]}><boxGeometry args={[0.03, 0.12, m.width * 0.45]} /><meshStandardMaterial color="#0B0F14" roughness={0.4} /></mesh>
      {[m.nose + 0.08, m.tail - 0.08].map(x => (
        <mesh key={x} position={[x, 0.4, 0]} rotation-y={x > 0 ? Math.PI / 2 : -Math.PI / 2}><planeGeometry args={[0.42, 0.11]} /><meshStandardMaterial color="#F8FAFC" /></mesh>
      ))}
      {[1, -1].map(s => (
        <group key={s} position={[m.mirrorX, m.mirrorY, s * (half + 0.08)]}>
          <mesh><boxGeometry args={[0.12, 0.09, 0.1]} /><meshStandardMaterial color={colour} metalness={0.5} roughness={0.3} /></mesh>
          <mesh position={[0, 0, s * -0.06]}><boxGeometry args={[0.04, 0.03, 0.06]} />{TRIM}</mesh>
        </group>
      ))}
      <CarLights front={m.nose + 0.01} back={m.tail - 0.01} y={m.lampY} tailY={m.tailY} w={half - 0.22} />
      {m.wheels.flatMap(x => [1, -1].map(s => <Wheel key={`${x}${s}`} at={[x, m.r, s * (half - 0.14)]} r={m.r} width={0.22} />))}
    </group>
  )
}

/** A city bus: a long rounded body, a band of windows, a big windscreen, the livery stripe. */
function Bus({ colour }: { colour: string }) {
  const W = 2.5
  const body = useMemo(() => profileSolid(s => {
    underside(s, -5.2, 5.2, 0.35, [-3.4, 3.3], 0.58)
    s.lineTo(5.25, 0.6); s.lineTo(5.3, 2.6); s.quadraticCurveTo(5.3, 3.08, 4.85, 3.1); s.lineTo(-4.95, 3.1)
    s.quadraticCurveTo(-5.25, 3.08, -5.25, 2.7); s.lineTo(-5.22, 0.35)
  }, W, 0.08), [])
  const windows = useMemo(() => Array.from({ length: 7 }, (_, k) => flankGeometry([[-4.7 + k * 1.33, 1.75], [-4.7 + k * 1.33 + 1.2, 1.75], [-4.7 + k * 1.33 + 1.2, 2.75], [-4.7 + k * 1.33, 2.75]])), [])
  return (
    <group>
      <mesh geometry={body} castShadow receiveShadow><meshPhysicalMaterial color={colour} metalness={0.3} roughness={0.35} clearcoat={0.6} /></mesh>
      {windows.map((g, i) => [1, -1].map(s => (
        <mesh key={`${i}${s}`} geometry={g} position={[0, 0, s * (W / 2 + 0.014)]} rotation-y={s < 0 ? Math.PI : 0} scale={[s < 0 ? -1 : 1, 1, 1]}>{GLASS_DARK}</mesh>
      )))}
      {[1, -1].map(s => <mesh key={`st${s}`} position={[0, 1.3, s * (W / 2 + 0.005)]} rotation-y={s < 0 ? Math.PI : 0}><planeGeometry args={[10.2, 0.16]} /><meshStandardMaterial color="#F8FAFC" /></mesh>)}
      {/* Windscreen and rear window stand just proud of the rounded ends, so they show */}
      <mesh position={[5.395, 2.15, 0]} rotation-y={Math.PI / 2}><planeGeometry args={[W - 0.24, 1.35]} /><meshStandardMaterial color="#0B0F14" roughness={0.6} side={DoubleSide} /></mesh>
      <mesh position={[5.4, 2.15, 0]} rotation-y={Math.PI / 2}><planeGeometry args={[W - 0.38, 1.22]} />{WINDSCREEN}</mesh>
      <mesh position={[-5.345, 2.4, 0]} rotation-y={-Math.PI / 2}><planeGeometry args={[W - 0.5, 0.8]} />{GLASS_DARK}</mesh>
      <RoundedBox args={[0.2, 0.3, W + 0.02]} radius={0.08} position={[5.28, 0.5, 0]} castShadow>{TRIM}</RoundedBox>
      <RoundedBox args={[0.2, 0.3, W + 0.02]} radius={0.08} position={[-5.26, 0.5, 0]} castShadow>{TRIM}</RoundedBox>
      <CarLights front={5.32} back={-5.28} y={0.85} tailY={0.9} w={0.95} />
      {[-3.4, 3.3].flatMap(x => [1, -1].map(s => <Wheel key={`${x}${s}`} at={[x, 0.5, s * (W / 2 - 0.18)]} r={0.5} width={0.3} />))}
    </group>
  )
}

/** An auto-rickshaw: a green tub with a rounded nose, a yellow canopy on posts, one wheel in front and two behind. */
function Auto() {
  const W = 1.35
  const tub = useMemo(() => profileSolid(s => {
    underside(s, -1.32, 1.05, 0.28, [-0.85], 0.32)
    s.quadraticCurveTo(1.4, 0.32, 1.34, 0.86); s.lineTo(1.13, 1.24); s.lineTo(0.98, 1.24); s.lineTo(0.95, 0.78); s.lineTo(-1.32, 0.78); s.lineTo(-1.32, 0.28)
  }, W, 0.07), [])
  const canopy = useMemo(() => profileSolid(s => {
    s.moveTo(-1.42, 1.58); s.lineTo(1.08, 1.64); s.quadraticCurveTo(1.18, 1.68, 1.1, 1.74); s.quadraticCurveTo(-0.2, 1.86, -1.3, 1.8); s.quadraticCurveTo(-1.45, 1.75, -1.42, 1.58)
  }, W + 0.08, 0.05), [])
  return (
    <group>
      <mesh geometry={tub} castShadow receiveShadow><meshPhysicalMaterial color="#15803D" metalness={0.3} roughness={0.35} clearcoat={0.7} /></mesh>
      <mesh geometry={canopy} castShadow><meshStandardMaterial color="#FACC15" roughness={0.6} /></mesh>
      <mesh position={[-0.2, 1.585, 0]}><boxGeometry args={[2.4, 0.02, W + 0.1]} /><meshStandardMaterial color="#111827" roughness={0.7} /></mesh>
      {[[-1.3, 0.62], [1.02, 0.6]].flatMap(([x, z]) => [1, -1].map(s => (
        <mesh key={`${x}${s}`} position={[x, 1.2, s * z]}><cylinderGeometry args={[0.025, 0.025, 0.85, 8]} />{TRIM}</mesh>
      )))}
      <Pane a={[1.13, 1.24]} b={[1.09, 1.62]} width={0.95} out={0.02} material={GLASS_DARK} />
      <mesh position={[0.75, 1.15, 0]} rotation-x={Math.PI / 2}><cylinderGeometry args={[0.02, 0.02, 0.6, 8]} />{CHROME}</mesh>
      <CarLights front={1.37} back={-1.36} y={0.75} tailY={0.6} w={0.45} />
      <Wheel at={[1.0, 0.25, 0]} r={0.25} width={0.14} />
      {[1, -1].map(s => <Wheel key={s} at={[-0.85, 0.27, s * 0.56]} r={0.27} width={0.16} />)}
    </group>
  )
}

/** A scooter and its rider, sitting on it, hands on the bars, helmet on. */
function Scooter({ colour }: { colour: string }) {
  const body = useMemo(() => profileSolid(s => {
    s.moveTo(-0.78, 0.36); s.lineTo(-0.8, 0.6); s.quadraticCurveTo(-0.62, 0.8, -0.15, 0.72); s.lineTo(0.12, 0.42); s.lineTo(0.4, 0.44)
    s.quadraticCurveTo(0.64, 0.6, 0.62, 1.08); s.lineTo(0.5, 1.08); s.quadraticCurveTo(0.44, 0.62, 0.26, 0.36); s.lineTo(-0.78, 0.36)
  }, 0.4, 0.05), [])
  const limbs = useLimbs()
  const look = useMemo(() => lookOf(colour + 'rider'), [colour])
  useEffect(() => {
    poseSit(limbs, 0.75)
    arms(limbs, -1.0, -0.5, -1.0, -0.5, 0.2, -0.2)
    if (limbs.torso.current) limbs.torso.current.rotation.x = 0.18
  }, [limbs])
  return (
    <group>
      <mesh geometry={body} castShadow><meshPhysicalMaterial color={colour} metalness={0.5} roughness={0.3} clearcoat={0.8} /></mesh>
      <RoundedBox args={[0.6, 0.1, 0.3]} radius={0.05} position={[-0.42, 0.8, 0]} castShadow><meshStandardMaterial color="#111827" roughness={0.7} /></RoundedBox>
      <mesh position={[0.55, 1.12, 0]} rotation-x={Math.PI / 2}><cylinderGeometry args={[0.018, 0.018, 0.62, 8]} />{CHROME}</mesh>
      <mesh position={[0.6, 1.0, 0]} rotation-z={-0.35}><cylinderGeometry args={[0.03, 0.03, 0.7, 10]} />{TRIM}</mesh>
      <CarLights front={0.64} back={-0.82} y={0.95} tailY={0.62} w={0.06} />
      <Wheel at={[0.62, 0.25, 0]} r={0.25} width={0.1} />
      <Wheel at={[-0.55, 0.25, 0]} r={0.25} width={0.1} />
      <group position={[-0.35, 0.02, 0]} rotation-y={Math.PI / 2}>
        <Body color="#334155" limbs={limbs} look={look} helmet="#DC2626" />
      </group>
    </group>
  )
}

/** A tyre on a rim with a hub and five spokes. */
function Wheel({ at, r, width = r * 0.6 }: { at: V3; r: number; width?: number }) {
  return (
    <group position={at} rotation-x={Math.PI / 2}>
      <mesh castShadow><cylinderGeometry args={[r, r, width, 24]} /><meshStandardMaterial color="#161616" roughness={0.92} /></mesh>
      <mesh><cylinderGeometry args={[r * 0.98, r * 0.98, width * 1.02, 24, 1, true]} /><meshStandardMaterial color="#222222" roughness={0.95} side={DoubleSide} /></mesh>
      <mesh><cylinderGeometry args={[r * 0.6, r * 0.6, width + 0.012, 20]} /><meshStandardMaterial color="#A3A9B2" metalness={0.9} roughness={0.22} /></mesh>
      <mesh><cylinderGeometry args={[r * 0.16, r * 0.16, width + 0.03, 12]} /><meshStandardMaterial color="#6B7280" metalness={0.9} roughness={0.3} /></mesh>
      {[0, 1, 2, 3, 4].map(k => (
        <mesh key={k} rotation-y={(k / 5) * Math.PI * 2}><boxGeometry args={[r * 0.08, width + 0.02, r * 0.95]} /><meshStandardMaterial color="#8B929C" metalness={0.9} roughness={0.25} /></mesh>
      ))}
    </group>
  )
}

/**
 * A Cyrix truck: a cab-over cab with a sloped windscreen, a wind deflector,
 * a ribbed cargo box on chassis rails, a fuel tank, mudguards, twin rear
 * wheels. Front at +x.
 */
function TruckBody({ red, words }: { red: boolean; words: CanvasTexture }) {
  const night = useNight()
  const W = 2.1
  const cab = useMemo(() => profileSolid(s => {
    underside(s, 1.4, 3.28, 0.62, [2.45], 0.6)
    s.lineTo(3.34, 0.7); s.lineTo(3.38, 1.32); s.lineTo(3.27, 1.46); s.quadraticCurveTo(3.13, 2.3, 2.96, 2.56)
    s.lineTo(1.55, 2.64); s.quadraticCurveTo(1.4, 2.62, 1.4, 2.42); s.lineTo(1.4, 0.62)
  }, W, 0.08), [])
  const deflector = useMemo(() => profileSolid(s => {
    s.moveTo(1.45, 2.6); s.lineTo(2.75, 2.62); s.quadraticCurveTo(1.9, 2.9, 1.5, 3.2); s.lineTo(1.45, 2.6)
  }, W - 0.1, 0.05), [])
  const side = useMemo(() => flankGeometry([[3.06, 1.62], [2.92, 2.42], [2.12, 2.48], [2.12, 1.62]]), [])
  const cabColour = red ? '#B91C1C' : '#C0262D'
  const boxColour = red ? '#D62F35' : '#F5F5F4'
  return (
    <group>
      <mesh geometry={cab} castShadow receiveShadow><meshPhysicalMaterial color={cabColour} metalness={0.45} roughness={0.3} clearcoat={0.9} clearcoatRoughness={0.1} /></mesh>
      <mesh geometry={deflector} castShadow><meshPhysicalMaterial color={cabColour} metalness={0.45} roughness={0.3} clearcoat={0.9} /></mesh>
      {[1, -1].map(s => (
        <mesh key={s} geometry={side} position={[0, 0, s * (W / 2 + 0.014)]} rotation-y={s < 0 ? Math.PI : 0} scale={[s < 0 ? -1 : 1, 1, 1]}>{GLASS_DARK}</mesh>
      ))}
      <Pane a={[3.28, 1.5]} b={[3.0, 2.48]} width={W - 0.18} out={0.105} material={<meshStandardMaterial color="#0B0F14" roughness={0.6} side={DoubleSide} />} />
      <Pane a={[3.27, 1.55]} b={[3.02, 2.42]} width={W - 0.32} out={0.11} material={WINDSCREEN} />
      {/* Door seam, step, mirrors on arms */}
      {[1, -1].map(s => (
        <group key={`d${s}`}>
          <mesh position={[2.05, 1.5, s * (W / 2 + 0.006)]} rotation-y={s < 0 ? Math.PI : 0}><planeGeometry args={[0.02, 1.7]} />{TRIM}</mesh>
          <mesh position={[2.55, 0.42, s * (W / 2 - 0.1)]}><boxGeometry args={[0.5, 0.05, 0.25]} />{CHROME}</mesh>
          <mesh position={[3.15, 2.05, s * (W / 2 + 0.18)]} rotation-x={s * 0.2}><boxGeometry args={[0.04, 0.04, 0.36]} />{TRIM}</mesh>
          <RoundedBox args={[0.08, 0.36, 0.2]} radius={0.03} position={[3.15, 1.9, s * (W / 2 + 0.36)]}>{TRIM}</RoundedBox>
        </group>
      ))}
      <mesh position={[3.4, 1.0, 0]}><boxGeometry args={[0.04, 0.42, 1.3]} /><meshStandardMaterial color="#0B0F14" roughness={0.4} /></mesh>
      {[0.88, 0.98, 1.08].map(y => <mesh key={y} position={[3.42, y, 0]}><boxGeometry args={[0.02, 0.025, 1.25]} />{CHROME}</mesh>)}
      <RoundedBox args={[0.2, 0.26, W + 0.04]} radius={0.07} position={[3.38, 0.6, 0]} castShadow><meshStandardMaterial color="#9CA3AF" metalness={0.7} roughness={0.3} /></RoundedBox>
      {[-0.78, 0.78].map(z => (
        <RoundedBox key={z} args={[0.06, 0.18, 0.34]} radius={0.03} position={[3.39, 0.95, z]}>
          <meshStandardMaterial color="#F8FAFC" emissive="#FFF1B8" emissiveIntensity={night ? 4 : 0.15} toneMapped={false} />
        </RoundedBox>
      ))}
      {/* The cargo box on its chassis */}
      {[-0.42, 0.42].map(z => <mesh key={z} position={[0.15, 0.78, z]} castShadow><boxGeometry args={[6.2, 0.2, 0.14]} />{TRIM}</mesh>)}
      <RoundedBox args={[4.3, 2.15, 2.2]} radius={0.05} position={[-0.75, 2.12, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={boxColour} roughness={0.42} metalness={0.15} />
      </RoundedBox>
      {[1, -1].map(s => (
        <group key={`b${s}`}>
          {Array.from({ length: 9 }, (_, k) => (
            <mesh key={k} position={[-2.75 + k * 0.5, 2.12, s * 1.104]} rotation-y={s < 0 ? Math.PI : 0}><planeGeometry args={[0.035, 2.1]} /><meshStandardMaterial color={red ? '#B91C1C' : '#D1D5DB'} /></mesh>
          ))}
          <mesh position={[-0.75, 2.3, s * 1.106]} rotation-y={s < 0 ? Math.PI : 0}>
            <planeGeometry args={[3.8, 0.75]} />
            <meshStandardMaterial map={words} transparent />
          </mesh>
          <mesh position={[-0.75, 1.55, s * 1.106]} rotation-y={s < 0 ? Math.PI : 0}>
            <planeGeometry args={[4.2, 0.12]} />
            <meshStandardMaterial color={red ? '#FFFFFF' : '#C0262D'} />
          </mesh>
          {/* Mudguards over the rear wheels, a fuel tank on one side */}
          <mesh position={[-2.1, 1.0, s * 0.92]} rotation-x={Math.PI / 2}><cylinderGeometry args={[0.6, 0.6, 0.5, 20, 1, true, -Math.PI / 2, Math.PI]} /><meshStandardMaterial color="#111827" roughness={0.7} side={DoubleSide} /></mesh>
        </group>
      ))}
      <mesh position={[0.5, 0.72, 0.85]} rotation-z={Math.PI / 2}><cylinderGeometry args={[0.22, 0.22, 0.9, 18]} />{CHROME}</mesh>
      {/* Rear doors with their lock bars, tail lights */}
      <mesh position={[-2.91, 2.12, 0]}><boxGeometry args={[0.02, 2.05, 2.1]} /><meshStandardMaterial color={boxColour} metalness={0.3} roughness={0.4} /></mesh>
      <mesh position={[-2.93, 2.12, 0]}><boxGeometry args={[0.02, 2.0, 0.03]} />{TRIM}</mesh>
      {[-0.55, 0.55].map(z => <mesh key={z} position={[-2.94, 2.12, z]}><cylinderGeometry args={[0.018, 0.018, 1.9, 8]} />{CHROME}</mesh>)}
      {[-0.85, 0.85].map(z => (
        <RoundedBox key={`t${z}`} args={[0.04, 0.14, 0.24]} radius={0.02} position={[-2.93, 1.2, z]}>
          <meshStandardMaterial color="#991B1B" emissive="#EF4444" emissiveIntensity={night ? 2.5 : 0.3} toneMapped={false} />
        </RoundedBox>
      ))}
      <Wheel at={[2.45, 0.5, 0.92]} r={0.5} width={0.3} />
      <Wheel at={[2.45, 0.5, -0.92]} r={0.5} width={0.3} />
      {[0.72, 1.02].flatMap(z => [-2.1].map(x => [1, -1].map(s => <Wheel key={`${x}${z}${s}`} at={[x, 0.5, s * z]} r={0.5} width={0.26} />)))}
    </group>
  )
}

/* ---------------------------------------------------------------- traffic */

type Kind = 'car' | 'hatch' | 'auto' | 'scooter' | 'bus' | 'van'
const CAR_COLOURS = ['#F8FAFC', '#1F2937', '#9CA3AF', '#B91C1C', '#1D4ED8', '#0F766E', '#D1D5DB', '#7C2D12']
const LENGTH: Record<Kind, number> = { car: 4.6, hatch: 4.0, auto: 2.8, scooter: 1.7, bus: 10.6, van: 4.3 }

/**
 * Traffic on the road (the user, 8 Oct: "random vehicle"): cars,
 * hatchbacks, autos, scooters, a van and a bus, both ways. Each keeps a safe
 * distance to whatever is ahead in its lane — the next vehicle or a truck
 * turning in — and slows down for it, so nobody drives through anybody.
 */
function Traffic() {
  const road = useContext(Road)
  const L = 160
  const fleet = useMemo(() => {
    const east: Kind[] = ['car', 'scooter', 'bus', 'hatch', 'auto', 'car']
    const west: Kind[] = ['auto', 'car', 'van', 'scooter', 'hatch', 'car', 'scooter']
    const make = (kinds: Kind[], dir: 1 | -1) => kinds.map((kind, i) => ({
      kind, dir, len: LENGTH[kind],
      colour: CAR_COLOURS[(i * 3 + (dir > 0 ? 0 : 4)) % CAR_COLOURS.length],
      vmax: kind === 'bus' ? 7 : kind === 'scooter' ? 9.5 : 8.5,
      x: -L / 2 + (i + 0.5) * (L / kinds.length) * dir,
      v: 6,
    }))
    return [...make(east, 1), ...make(west, -1)]
  }, [])
  const refs = useRef<Array<Group | null>>([])
  const wrap = (x: number) => ((x + L / 2) % L + L) % L - L / 2
  useFrame((_, dt) => {
    const step = Math.min(dt, 0.05)
    const trucks = road ? Object.values(road.current).filter(o => o.truck && o.onLane) : []
    fleet.forEach((v, i) => {
      // The nearest thing ahead in the same lane, and the room left to it.
      let gap = Infinity
      for (const o of fleet) {
        if (o === v || o.dir !== v.dir) continue
        const d = ((o.x - v.x) * v.dir + L) % L
        gap = Math.min(gap, d - (o.len + v.len) / 2)
      }
      if (v.dir > 0) {
        for (const t of trucks) {
          const d = (t.x - v.x) * v.dir
          if (d > 0) gap = Math.min(gap, d - (t.len + v.len) / 2)
        }
      }
      const want = Math.max(0, Math.min(v.vmax, (gap - 3) * 1.1))
      v.v += (want - v.v) * Math.min(1, step * (want < v.v ? 4 : 1.2))
      v.x = wrap(v.x + v.dir * v.v * step)
      if (road && v.dir > 0) road.current[`v${i}`] = { x: v.x, len: v.len, onLane: true }
      const g = refs.current[i]
      if (g) g.position.x = v.x
    })
  })
  return (
    <group>
      {fleet.map((v, i) => (
        <group key={i} ref={el => { refs.current[i] = el }} position={[v.x, 0, v.dir > 0 ? EAST_LANE : WEST_LANE]} rotation-y={v.dir > 0 ? 0 : Math.PI}>
          <Vehicle kind={v.kind} colour={v.colour} />
        </group>
      ))}
    </group>
  )
}

function Vehicle({ kind, colour }: { kind: Kind; colour: string }) {
  if (kind === 'car' || kind === 'hatch' || kind === 'van') return <Car kind={kind} colour={kind === 'van' ? '#F1F5F9' : colour} />
  if (kind === 'bus') return <Bus colour="#B91C1C" />
  if (kind === 'auto') return <Auto />
  return <Scooter colour={colour} />
}

/* ---------------------------------------------------------------- lamps by the road */

function StreetLights() {
  const night = useNight()
  return (
    <group>
      {[-36, -24, -12, 0, 12, 24, 36].map(x => (
        <group key={x} position={[x, 0, ROAD_Z + 3.6]} rotation-y={Math.PI}>
          <mesh position={[0, 2.6, 0]} castShadow><cylinderGeometry args={[0.07, 0.11, 5.2, 10]} /><meshStandardMaterial color="#4B5563" metalness={0.6} roughness={0.45} /></mesh>
          <mesh position={[0, 5.15, 0.7]} rotation-x={Math.PI / 2}><cylinderGeometry args={[0.05, 0.05, 1.4, 8]} /><meshStandardMaterial color="#4B5563" metalness={0.6} roughness={0.45} /></mesh>
          <mesh position={[0, 5.05, 1.4]}>
            <boxGeometry args={[0.55, 0.12, 0.32]} />
            <meshStandardMaterial color={night ? '#FFF3D6' : '#D1D5DB'} emissive={night ? '#FFC872' : '#000000'} emissiveIntensity={night ? 3 : 0} toneMapped={false} />
          </mesh>
          {night && <pointLight color="#FFC872" intensity={22} distance={14} decay={2} position={[0, 4.8, 1.5]} />}
        </group>
      ))}
    </group>
  )
}

/* ---------------------------------------------------------------- green */

/**
 * The grounds (the user, 8 Oct: "trees looks like not realistic"): leafy
 * trees with irregular canopies, coconut palms with drooping fronds, hedges,
 * planters and tufts of grass; parked cars; clouds by day and a moon by night.
 */
function Outside() {
  const night = useNight()
  return (
    <group>
      <Trees />
      <Palms />
      <Hedges />
      <Flowers />
      <GrassTufts />
      <group position={[-21, 0, APRON_Z]}><Vehicle kind="car" colour="#1D4ED8" /></group>
      <group position={[-26, 0, APRON_Z]}><Vehicle kind="hatch" colour="#F8FAFC" /></group>
      <group position={[21.5, 0, APRON_Z]} rotation-y={Math.PI}><Vehicle kind="car" colour="#991B1B" /></group>
      <Traffic />
      {night ? <Moon /> : <Clouds />}
    </group>
  )
}

/** A rounded lump with an uneven surface, shared by every tree's canopy. */
function useLeafGeometry() {
  return useMemo(() => {
    const geo = new IcosahedronGeometry(1, 3)
    const p = geo.attributes.position
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i)
      const n = 1 + 0.16 * Math.sin(x * 5.1 + y * 3.7) * Math.cos(z * 4.3 - y * 2.1) + 0.08 * Math.sin(x * 11 + z * 9)
      p.setXYZ(i, x * n, y * n * 0.86, z * n)
    }
    geo.computeVertexNormals()
    return geo
  }, [])
}

const LEAVES = ['#2F6B2A', '#3B7F33', '#4A903C', '#56A146']
function Trees() {
  const leaf = useLeafGeometry()
  const spots: Array<[number, number, number]> = [
    [-24, -3, 1.1], [-25, 12.5, 0.95], [24, -2, 1.2], [25, 12, 1.0], [-3, -14.5, 1.1], [9, -15, 0.95],
    [-17, -14, 1.05], [17, -14.5, 1.15], [-31, -8, 1.3], [31, -9, 1.25], [-31, 24, 1.05], [31, 24, 1.1],
    [-9, 24, 0.95], [10, 24.5, 1.05], [-38, 4, 1.2], [38, 2, 1.15], [0, 26, 1.1], [-20, 25, 0.9], [20, 25.5, 1],
  ]
  return (
    <group>
      {spots.map(([x, z, s], i) => (
        <group key={`${x}${z}`} position={[x, 0, z]} scale={s} rotation-y={i * 1.3}>
          <mesh position={[0, 1.1, 0]} rotation-z={0.05} castShadow><cylinderGeometry args={[0.13, 0.24, 2.2, 10]} /><meshStandardMaterial color="#5B3A22" roughness={0.95} /></mesh>
          <mesh position={[0.35, 2.1, 0]} rotation-z={-0.7} castShadow><cylinderGeometry args={[0.06, 0.1, 1.1, 8]} /><meshStandardMaterial color="#5B3A22" roughness={0.95} /></mesh>
          <mesh position={[-0.3, 2.2, 0.1]} rotation-z={0.6} castShadow><cylinderGeometry args={[0.05, 0.09, 1.0, 8]} /><meshStandardMaterial color="#5B3A22" roughness={0.95} /></mesh>
          {[[0, 3.2, 0, 1.45], [0.85, 2.8, 0.3, 1.0], [-0.8, 2.85, -0.2, 1.05], [0.2, 2.7, -0.85, 0.9], [-0.2, 3.9, 0.2, 0.95], [0.3, 2.6, 0.8, 0.85]].map(([px, py, pz, ps], k) => (
            <mesh key={k} geometry={leaf} position={[px, py, pz]} scale={ps} castShadow receiveShadow>
              <meshStandardMaterial color={LEAVES[(k + i) % LEAVES.length]} roughness={0.9} />
            </mesh>
          ))}
        </group>
      ))}
    </group>
  )
}

/** A coconut frond: long, tapering, drooping at the end. */
function useFrondGeometry() {
  return useMemo(() => {
    const L = 2.6
    const geo = new PlaneGeometry(L, 0.7, 12, 3)
    geo.rotateX(-Math.PI / 2)
    geo.translate(L / 2, 0, 0)
    const p = geo.attributes.position
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i)
      const u = x / L
      p.setZ(i, z * (1 - 0.8 * u) * (0.6 + 0.4 * Math.sin(u * Math.PI)))
      p.setY(i, 0.5 * u - 1.6 * u * u - Math.abs(z) * 0.4)
    }
    geo.computeVertexNormals()
    return geo
  }, [])
}

function Palms() {
  const frond = useFrondGeometry()
  const spots: Array<[number, number, number, number]> = [
    [-19, -7, 1.1, 0.2], [-20.5, 0, 1.25, -0.25], [-19.2, 6, 1, 0.35], [19, -8, 1.2, -0.2], [20.5, -1, 1.05, 0.3],
    [19.5, 6.5, 1.3, -0.35], [-11, -12.6, 1.15, 0.1], [3, -13, 1.25, -0.2], [13, -12.6, 1, 0.3], [-28, 8, 1.2, 0.2], [28, 6, 1.1, -0.3],
    [-34, -14, 1.2, 0.15], [34, -15, 1.1, -0.2],
  ]
  return (
    <group>
      {spots.map(([x, z, s, lean], i) => {
        const top: V3 = [Math.sin(lean) * 3.0, 5.2, 0]
        return (
          <group key={i} position={[x, 0, z]} scale={s} rotation-y={i * 0.9}>
            {Array.from({ length: 10 }, (_, k) => {
              const u = k / 10
              return (
                <mesh key={k} position={[Math.sin(lean) * 3.0 * u * u, 0.26 + k * 0.52, 0]} rotation-z={-lean * u * 1.4} castShadow>
                  <cylinderGeometry args={[0.15 - u * 0.04, 0.18 - u * 0.04, 0.54, 10]} />
                  <meshStandardMaterial color={k % 2 ? '#8B6B4A' : '#7A5C3E'} roughness={0.95} />
                </mesh>
              )
            })}
            <group position={top}>
              {Array.from({ length: 11 }, (_, k) => (
                <mesh key={k} geometry={frond} rotation-y={(k / 11) * Math.PI * 2 + (k % 2) * 0.2} rotation-z={0.15 + (k % 3) * 0.12} castShadow>
                  <meshStandardMaterial color={k % 2 ? '#3E8E2E' : '#4D9F38'} roughness={0.8} side={DoubleSide} />
                </mesh>
              ))}
              {[0, 2.1, 4.2].map(a => (
                <mesh key={a} position={[Math.cos(a) * 0.17, -0.25, Math.sin(a) * 0.17]} castShadow><sphereGeometry args={[0.14, 12, 10]} /><meshStandardMaterial color="#6B5A2E" roughness={0.7} /></mesh>
              ))}
            </group>
          </group>
        )
      })}
    </group>
  )
}

/** Clipped hedges along the sides and back of the building. */
function Hedges() {
  const leaf = useLeafGeometry()
  const rows: Array<[number, number, number, number]> = [[0, -HALF_Z - 0.9, HALF_X * 2 + 1.4, 0.8], [-HALF_X - 0.9, 0, 0.8, HALF_Z * 2], [HALF_X + 0.9, -1.5, 0.8, HALF_Z * 2 - 3]]
  return (
    <group>
      {rows.map(([x, z, w, d]) => {
        const along = w > d
        const n = Math.round((along ? w : d) / 0.9)
        return Array.from({ length: n }, (_, k) => {
          const o = -((along ? w : d) / 2) + 0.45 + k * 0.9
          return (
            <mesh key={`${x}${z}${k}`} geometry={leaf} position={[x + (along ? o : 0), 0.45, z + (along ? 0 : o)]} scale={[0.55, 0.5, 0.55]} castShadow receiveShadow>
              <meshStandardMaterial color={k % 2 ? '#3C7A2E' : '#467F35'} roughness={0.95} />
            </mesh>
          )
        })
      })}
    </group>
  )
}

/** Tufts of grass over the lawn, drawn as one batch so there can be many. */
function GrassTufts() {
  const ref = useRef<InstancedMesh>(null)
  const count = 1400
  useEffect(() => {
    const m = ref.current
    if (!m) return
    const d = new Object3D()
    const c = new Color()
    let i = 0, k = 0
    while (i < count && k < count * 6) {
      k++
      const x = Math.sin(k * 12.9898) * 43758.5453 % 1 * 120 - 60
      const z = Math.sin(k * 78.233) * 12543.123 % 1 * 90 - 32
      const inBuilding = Math.abs(x) < HALF_X + 1.6 && z > -HALF_Z - 1.6 && z < ROAD_Z - 3
      const onRoad = Math.abs(z - ROAD_Z) < 5
      if (inBuilding || onRoad) continue
      d.position.set(x, 0, z)
      d.rotation.set(0, k, 0)
      d.scale.setScalar(0.7 + (k % 7) * 0.12)
      d.updateMatrix()
      m.setMatrixAt(i, d.matrix)
      m.setColorAt(i, c.set(['#5E8F3E', '#6FA049', '#7DB055', '#557F38'][k % 4]))
      i++
    }
    m.count = i
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
  }, [])
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]} receiveShadow>
      <coneGeometry args={[0.07, 0.32, 4]} />
      <meshStandardMaterial roughness={1} />
    </instancedMesh>
  )
}

/** Concrete planters with leafy shrubs and small flowers on them (the user, 8 Oct: "what is this" — the first try read as balls on a tray). */
function Flowers() {
  const beds: Array<[number, number]> = [[-5, HALF_Z + 1.1], [5, HALF_Z + 1.1], [-2, -HALF_Z - 2], [8, -HALF_Z - 2]]
  const blooms = ['#F43F5E', '#FACC15', '#F97316', '#E879F9']
  return (
    <group>
      {beds.map(([x, z], b) => (
        <group key={b} position={[x, 0, z]}>
          <RoundedBox args={[3.2, 0.45, 0.95]} radius={0.06} position={[0, 0.22, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#B9B4AA" roughness={0.9} />
          </RoundedBox>
          <mesh position={[0, 0.455, 0]} rotation-x={-Math.PI / 2}><planeGeometry args={[3.0, 0.78]} /><meshStandardMaterial color="#5A3E28" roughness={1} /></mesh>
          {[-1.1, -0.37, 0.37, 1.1].map((sx, i) => (
            <group key={sx} position={[sx, 0.62, 0]}>
              <mesh castShadow><icosahedronGeometry args={[0.36, 1]} /><meshStandardMaterial color={i % 2 ? '#3F8A35' : '#4E9C3F'} roughness={0.95} flatShading /></mesh>
              {[[0.12, 0.26, 0.12], [-0.16, 0.22, -0.05], [0.02, 0.3, -0.16], [-0.05, 0.2, 0.2]].map(([fx, fy, fz], k) => (
                <mesh key={k} position={[fx, fy, fz]}>
                  <dodecahedronGeometry args={[0.055, 0]} />
                  <meshStandardMaterial color={blooms[(i + k + b) % blooms.length]} roughness={0.6} />
                </mesh>
              ))}
            </group>
          ))}
        </group>
      ))}
    </group>
  )
}

/** Soft clouds drifting slowly across a day sky. */
function Clouds() {
  const g = useRef<Group>(null)
  useFrame((_, dt) => {
    if (!g.current) return
    for (const c of g.current.children) { c.position.x += dt * 0.6; if (c.position.x > 55) c.position.x = -55 }
  })
  const puffs: Array<[number, number, number, number]> = [[-34, 19, -26, 1.5], [-6, 21, -32, 1.9], [20, 18, -24, 1.3], [40, 20, -34, 1.7], [-46, 22, -10, 1.4]]
  return (
    <group ref={g}>
      {puffs.map(([x, y, z, s], i) => (
        <group key={i} position={[x, y, z]} scale={s}>
          {[[0, 0, 0, 1.4], [1.4, -0.2, 0.2, 1.05], [-1.4, -0.25, -0.1, 1.1], [0.6, 0.6, 0, 0.95], [-0.6, 0.5, 0.3, 0.9]].map(([px, py, pz, r], k) => (
            <mesh key={k} position={[px, py, pz]}><sphereGeometry args={[r, 14, 10]} /><meshStandardMaterial color="#FFFFFF" roughness={1} transparent opacity={0.92} /></mesh>
          ))}
        </group>
      ))}
    </group>
  )
}

function Moon() {
  return (
    <group position={[-32, 30, -46]}>
      <mesh><sphereGeometry args={[2.4, 24, 18]} /><meshStandardMaterial color="#F5F3E7" emissive="#FFF8DC" emissiveIntensity={1.2} toneMapped={false} /></mesh>
    </group>
  )
}
