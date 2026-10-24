import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { Check, Eraser, Pencil, Undo2, X } from 'lucide-react'
import { Spinner } from '@/components/ui'

/**
 * A pen over a component's photo: on a big machine, a ring round the part that is wanted (the user, 22 Oct). Drawn
 * with a finger or the mouse, in a colour of the person's choice; Save hands back the photo with the marks in it.
 */

const COLOURS = ['#ef4444', '#facc15', '#22c55e', '#3b82f6', '#ffffff', '#111827']
const SIZES = [{ id: 's', px: 0.004, label: 'Thin' }, { id: 'm', px: 0.008, label: 'Medium' }, { id: 'l', px: 0.016, label: 'Thick' }] as const

type Stroke = { colour: string; width: number; points: Array<[number, number]> }

export default function MarkUp({ src, onSave, onClose }: {
  src: string
  onSave: (blob: Blob) => Promise<void> | void
  onClose: () => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const image = useRef<HTMLImageElement | null>(null)
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [colour, setColour] = useState(COLOURS[0])
  const [size, setSize] = useState<(typeof SIZES)[number]['id']>('m')
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [saving, setSaving] = useState(false)
  const drawing = useRef<Stroke | null>(null)

  useEffect(() => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => { image.current = img; setReady(true) }
    img.onerror = () => setFailed(true)
    img.src = src
  }, [src])

  useEffect(() => {
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = overflow }
  }, [onClose])

  const paint = (list: Stroke[]) => {
    const c = canvas.current, img = image.current
    if (!c || !img) return
    const ctx = c.getContext('2d')!
    ctx.drawImage(img, 0, 0, c.width, c.height)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    for (const s of list) {
      ctx.strokeStyle = s.colour
      ctx.lineWidth = s.width
      ctx.beginPath()
      s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
      if (s.points.length === 1) ctx.lineTo(s.points[0][0] + 0.1, s.points[0][1])
      ctx.stroke()
    }
  }

  useEffect(() => {
    const c = canvas.current, img = image.current
    if (!ready || !c || !img) return
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    paint(strokes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  useEffect(() => { if (ready) paint(strokes) }, [strokes, ready]) // eslint-disable-line react-hooks/exhaustive-deps

  const at = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const c = canvas.current!
    const r = c.getBoundingClientRect()
    return [((e.clientX - r.left) / r.width) * c.width, ((e.clientY - r.top) / r.height) * c.height]
  }

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!ready) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const c = canvas.current!
    const width = Math.max(2, Math.max(c.width, c.height) * SIZES.find(s => s.id === size)!.px)
    drawing.current = { colour, width, points: [at(e)] }
    paint([...strokes, drawing.current])
  }
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    drawing.current.points.push(at(e))
    paint([...strokes, drawing.current])
  }
  const up = () => {
    if (!drawing.current) return
    const s = drawing.current
    drawing.current = null
    setStrokes(list => [...list, s])
  }

  // A save that fails is said here, beside Save — nothing behind the marker can be seen (the user, 24 Oct).
  const [failedSave, setFailedSave] = useState<string | null>(null)
  const save = async () => {
    const c = canvas.current
    if (!c) return
    setSaving(true); setFailedSave(null)
    try {
      const blob = await new Promise<Blob | null>(res => c.toBlob(res, 'image/jpeg', 0.85))
      if (!blob) throw new Error('The photo could not be saved.')
      await onSave(blob)
    } catch (err) {
      setFailedSave(err instanceof Error ? err.message : 'The marked photo did not save.')
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Mark the photo" className="fixed inset-0 z-[60] flex flex-col bg-black/90">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-white sm:gap-3 sm:px-4">
        <span className="flex items-center gap-1.5 text-sm font-semibold"><Pencil className="h-4 w-4" /> Mark the photo</span>
        <div className="flex items-center gap-1.5" role="group" aria-label="Pen colour">
          {COLOURS.map(c => (
            <button
              key={c}
              type="button"
              onClick={() => setColour(c)}
              aria-label={`Colour ${c}`}
              aria-pressed={colour === c}
              className={clsx('h-7 w-7 rounded-full border-2 transition-transform', colour === c ? 'scale-110 border-white' : 'border-white/30')}
              style={{ background: c }}
            />
          ))}
          <label className={clsx('relative h-7 w-7 cursor-pointer overflow-hidden rounded-full border-2', !COLOURS.includes(colour) ? 'border-white' : 'border-white/30')}
            style={{ background: 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' }} title="Any colour">
            <input type="color" value={colour} onChange={e => setColour(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Any colour" />
          </label>
        </div>
        <div className="flex items-center rounded-lg bg-white/10 p-0.5" role="group" aria-label="Pen size">
          {SIZES.map(s => (
            <button key={s.id} type="button" onClick={() => setSize(s.id)} aria-pressed={size === s.id} title={s.label}
              className={clsx('grid h-7 w-8 place-items-center rounded-md', size === s.id && 'bg-white/20')}>
              <span className="rounded-full bg-white" style={{ width: s.id === 's' ? 4 : s.id === 'm' ? 7 : 11, height: s.id === 's' ? 4 : s.id === 'm' ? 7 : 11 }} />
            </button>
          ))}
        </div>
        <button type="button" onClick={() => setStrokes(l => l.slice(0, -1))} disabled={!strokes.length}
          className="btn-press inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-white/10 disabled:opacity-40">
          <Undo2 className="h-4 w-4" /> Undo
        </button>
        <button type="button" onClick={() => setStrokes([])} disabled={!strokes.length}
          className="btn-press inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm hover:bg-white/10 disabled:opacity-40">
          <Eraser className="h-4 w-4" /> Clear
        </button>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onClose} className="btn-press inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-sm hover:bg-white/10">
            <X className="h-4 w-4" /> Cancel
          </button>
          <button type="button" onClick={save} disabled={!ready || saving || !strokes.length}
            className="btn-press inline-flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-semibold text-gray-900 disabled:opacity-50">
            {saving ? <Spinner className="h-4 w-4" /> : <Check className="h-4 w-4 text-emerald-600" />} Save
          </button>
        </div>
        {failedSave && (
          <p role="alert" className="animate-pop-in w-full rounded-md bg-cyrixRed-600 px-3 py-1.5 text-sm font-medium text-white sm:text-right">
            {failedSave}
          </p>
        )}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-2 sm:p-4">
        {failed ? <p className="text-sm text-white/80">The photo could not be opened.</p>
          : !ready ? <Spinner className="h-6 w-6 text-white" />
            : null}
        <canvas
          ref={canvas}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          className={clsx('max-h-full max-w-full touch-none rounded-md', (!ready || failed) && 'hidden')}
          style={{ cursor: 'crosshair' }}
        />
      </div>
    </div>,
    document.body,
  )
}
