import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Camera, Mic, Square, Trash2, X } from 'lucide-react'
import {
  MAX_PHOTOS, MAX_VOICE_SECONDS, clock, compressPhoto, humanSize, pickRecorderMime,
} from '@/lib/media'
import { Spinner } from '@/components/ui'

export interface PendingPhoto {
  blob: Blob
  preview: string
}

/**
 * Up to two photos of the fault.
 *
 * On a phone the button opens the camera straight away; on a computer it
 * opens the file picker. Every photo is shrunk in the browser before it is
 * kept, so what is shown here is exactly what will be sent.
 */
export function PhotoPicker({
  photos, onChange, max = MAX_PHOTOS,
}: {
  photos: PendingPhoto[]
  onChange: (next: PendingPhoto[]) => void
  max?: number
}) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Object URLs are memory until revoked.
  useEffect(() => () => photos.forEach(p => URL.revokeObjectURL(p.preview)), []) // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (files: FileList | null) => {
    if (!files?.length) return
    setError(null); setBusy(true)
    try {
      const room = max - photos.length
      const picked = [...files].slice(0, room)
      const made: PendingPhoto[] = []
      for (const f of picked) {
        const blob = await compressPhoto(f)
        made.push({ blob, preview: URL.createObjectURL(blob) })
      }
      onChange([...photos, ...made])
      if (files.length > room) setError(`Only ${max} photos fit on a ticket — the rest were left out.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That photo could not be added.')
    } finally {
      setBusy(false)
    }
  }

  const drop = (i: number) => {
    URL.revokeObjectURL(photos[i].preview)
    onChange(photos.filter((_, j) => j !== i))
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {photos.map((p, i) => (
          <div key={p.preview} className="relative h-24 w-24 overflow-hidden rounded-lg border border-ink-200">
            <img src={p.preview} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => drop(i)}
              className="absolute right-1 top-1 rounded-full bg-black/60 p-1 text-white"
              aria-label={`Remove photo ${i + 1}`}
            >
              <X className="h-3.5 w-3.5" />
            </button>
            <span className="absolute bottom-0 inset-x-0 bg-black/50 px-1 text-center text-[10px] text-white">
              {humanSize(p.blob.size)}
            </span>
          </div>
        ))}
        {photos.length < max && (
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={busy}
            className="flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-ink-300 text-xs text-ink-500 hover:border-ink-500 hover:text-ink-800"
          >
            {busy ? <Spinner className="h-5 w-5" /> : <Camera className="h-5 w-5" />}
            {busy ? 'Preparing…' : `Add photo`}
            <span className="text-[10px] text-ink-400">{photos.length} of {max}</span>
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={e => { void add(e.target.files); e.target.value = '' }}
      />
      {error && <p className="text-xs text-amber-700">{error}</p>}
    </div>
  )
}

/**
 * A voice note of up to a minute, to explain what a photo cannot.
 *
 * Stops on its own at 60 seconds. Recorded at speech quality, so the whole
 * minute is a few hundred kilobytes. Played back before it is sent, and
 * recorded again if it came out wrong.
 */
export function VoiceRecorder({
  voice, onChange,
}: {
  voice: Blob | null
  onChange: (next: Blob | null) => void
}) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<number | null>(null)
  const stream = useRef<MediaStream | null>(null)

  useEffect(() => {
    if (!voice) { setUrl(null); return }
    const u = URL.createObjectURL(voice)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [voice])

  // Leaving the page mid-recording must release the microphone.
  useEffect(() => () => stopAll(), []) // eslint-disable-line react-hooks/exhaustive-deps

  const stopAll = () => {
    if (timer.current) { window.clearInterval(timer.current); timer.current = null }
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop()
    stream.current?.getTracks().forEach(t => t.stop())
    stream.current = null
  }

  const start = async () => {
    setError(null)
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot record audio.')
      return
    }
    const mime = pickRecorderMime(m => MediaRecorder.isTypeSupported(m))
    if (!mime) { setError('This browser cannot record in a format that can be sent.'); return }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError('Microphone access was not allowed. Allow it for this site to record a note.')
      return
    }
    chunks.current = []
    const rec = new MediaRecorder(stream.current, { mimeType: mime, audioBitsPerSecond: 32_000 })
    rec.ondataavailable = e => { if (e.data.size > 0) chunks.current.push(e.data) }
    rec.onstop = () => {
      const blob = new Blob(chunks.current, { type: mime.split(';')[0] })
      if (blob.size > 0) onChange(blob)
      setRecording(false)
    }
    recorder.current = rec
    rec.start(1000)
    setSeconds(0)
    setRecording(true)
    const began = Date.now()
    timer.current = window.setInterval(() => {
      const s = (Date.now() - began) / 1000
      setSeconds(s)
      if (s >= MAX_VOICE_SECONDS) stopAll()
    }, 250)
  }

  return (
    <div className="space-y-2">
      {recording ? (
        <div className="flex items-center gap-3 rounded-lg border border-cyrixRed-200 bg-cyrixRed-50 px-3 py-2">
          <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-cyrixRed-600" />
          <span className="font-mono text-sm tabular-nums text-cyrixRed-900">
            {clock(seconds)} / {clock(MAX_VOICE_SECONDS)}
          </span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-cyrixRed-100">
            <div className="h-full bg-cyrixRed-500" style={{ width: `${Math.min(100, (seconds / MAX_VOICE_SECONDS) * 100)}%` }} />
          </div>
          <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={stopAll}>
            <Square className="h-3.5 w-3.5" /> Stop
          </button>
        </div>
      ) : voice && url ? (
        <div className="flex flex-wrap items-center gap-2">
          <audio controls src={url} className={clsx('h-10 max-w-full')} />
          <span className="text-xs text-ink-400">{humanSize(voice.size)}</span>
          <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => onChange(null)}>
            <Trash2 className="h-3.5 w-3.5" /> Record again
          </button>
        </div>
      ) : (
        <button type="button" className="btn-secondary" onClick={() => void start()}>
          <Mic className="h-4 w-4" /> Record a voice note
          <span className="text-xs text-ink-400">up to 1 minute</span>
        </button>
      )}
      {error && <p className="text-xs text-amber-700">{error}</p>}
    </div>
  )
}
