import { useEffect, useRef, useState } from 'react'
import { Camera, Images, X } from 'lucide-react'
import { compressPhoto, humanSize } from '@/lib/media'
import { Spinner } from '@/components/ui'
import Lightbox from '@/components/Lightbox'

export interface PickedPhoto {
  blob: Blob
  preview: string
}

/** A phone or a tablet, where the camera and the gallery are two different taps. */
const PHONE = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

/**
 * A few photos from the camera or the gallery: a component, or a bill's
 * pages. Each is shrunk before it is kept, so what shows is what is sent.
 * The original file goes to `onOriginal` first — reading a bill works best
 * on the photo as the camera took it.
 */
export default function PhotoPick({
  photos, onChange, max, noun, size, onOriginal,
}: {
  photos: PickedPhoto[]
  onChange: (next: PickedPhoto[]) => void
  max: number
  /** "photo", "bill page". */
  noun: string
  size?: { maxSide?: number; targetBytes?: number }
  onOriginal?: (file: File) => void
}) {
  const camera = useRef<HTMLInputElement>(null)
  const gallery = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<number | null>(null)

  const held = useRef(photos)
  held.current = photos
  useEffect(() => () => held.current.forEach(p => URL.revokeObjectURL(p.preview)), [])

  const add = async (files: FileList | null) => {
    if (!files?.length) return
    setError(null); setBusy(true)
    try {
      const room = max - photos.length
      const made: PickedPhoto[] = []
      for (const f of [...files].slice(0, room)) {
        onOriginal?.(f)
        const blob = await compressPhoto(f, size)
        made.push({ blob, preview: URL.createObjectURL(blob) })
      }
      onChange([...photos, ...made])
    } catch (err) {
      setError(err instanceof Error ? err.message : `That ${noun} could not be added.`)
    } finally {
      setBusy(false)
    }
  }

  const drop = (i: number) => {
    URL.revokeObjectURL(photos[i].preview)
    onChange(photos.filter((_, j) => j !== i))
  }

  const full = photos.length >= max
  return (
    <div className="space-y-2">
      {photos.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {photos.map((p, i) => (
            <div key={p.preview} className="relative h-20 w-20 overflow-hidden rounded-lg border border-ink-200">
              <button type="button" onClick={() => setViewing(i)} className="block h-full w-full" aria-label={`View ${noun} ${i + 1}`}>
                <img src={p.preview} alt="" className="h-full w-full object-cover" />
              </button>
              <button
                type="button"
                onClick={() => drop(i)}
                className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white"
                aria-label={`Remove ${noun} ${i + 1}`}
              >
                <X className="h-3 w-3" />
              </button>
              <span className="absolute inset-x-0 bottom-0 bg-black/50 text-center text-[10px] text-white">{humanSize(p.blob.size)}</span>
            </div>
          ))}
        </div>
      )}
      {!full && (
        <div className="flex flex-wrap gap-2">
          {PHONE && (
            <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={() => camera.current?.click()} disabled={busy}>
              {busy ? <Spinner className="h-4 w-4" /> : <Camera className="h-4 w-4 text-sky-600" />} Camera
            </button>
          )}
          <button type="button" className="btn-secondary !py-1.5 text-sm" onClick={() => gallery.current?.click()} disabled={busy}>
            {busy && !PHONE ? <Spinner className="h-4 w-4" /> : <Images className="h-4 w-4 text-sky-600" />} {PHONE ? 'Gallery' : `Choose ${noun}`}
          </button>
          {max > 1 && <span className="self-center text-xs text-ink-400">{photos.length} of {max}</span>}
        </div>
      )}
      {error && <p className="text-xs text-amber-700">{error}</p>}
      {PHONE && (
        <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden"
          onChange={e => { void add(e.target.files); e.target.value = '' }} />
      )}
      <input ref={gallery} type="file" accept="image/*" multiple={max > 1} className="hidden"
        onChange={e => { void add(e.target.files); e.target.value = '' }} />
      <Lightbox
        images={photos.map((p, i) => ({ src: p.preview, alt: `${noun} ${i + 1}` }))}
        index={viewing}
        onIndex={setViewing}
        onClose={() => setViewing(null)}
      />
    </div>
  )
}
