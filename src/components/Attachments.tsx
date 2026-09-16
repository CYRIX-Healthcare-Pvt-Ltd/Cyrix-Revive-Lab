import { useEffect, useRef, useState } from 'react'
import { Camera, Mic, Square, Trash2, Video, X } from 'lucide-react'
import {
  MAX_PHOTOS, MAX_UPLOAD_BYTES, MAX_VIDEO_SECONDS, MAX_VOICE_SECONDS,
  VIDEO_BITS_PER_SECOND, VIDEO_FPS, VIDEO_HEIGHT, VIDEO_WIDTH, VOICE_BITS_PER_SECOND,
  clock, compressPhoto, humanSize, pickRecorderMime, pickVideoRecorderMime,
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
            <span className="absolute inset-x-0 bottom-0 bg-black/50 px-1 text-center text-[10px] text-white">
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
            {busy ? 'Preparing…' : 'Add photo'}
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

/* ------------------------------------------------------------------ */

/**
 * What both recorders share: asking for the microphone (and camera),
 * counting up to the limit, stopping on their own, and always giving the
 * devices back — leaving a page mid-recording must not keep the camera on.
 */
function useRecorder({
  maxSeconds, pickMime, constraints, bitrates, onDone,
}: {
  maxSeconds: number
  pickMime: (isSupported: (m: string) => boolean) => string | null
  constraints: MediaStreamConstraints
  bitrates: { audioBitsPerSecond?: number; videoBitsPerSecond?: number }
  onDone: (blob: Blob) => void
}) {
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<number | null>(null)
  const live = useRef<MediaStream | null>(null)

  const release = () => {
    if (timer.current) { window.clearInterval(timer.current); timer.current = null }
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop()
    live.current?.getTracks().forEach(t => t.stop())
    live.current = null
    setStream(null)
  }

  useEffect(() => () => release(), []) // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    setError(null)
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot record here.')
      return
    }
    const mime = pickMime(m => MediaRecorder.isTypeSupported(m))
    if (!mime) { setError('This browser cannot record in a format that can be sent.'); return }
    try {
      live.current = await navigator.mediaDevices.getUserMedia(constraints)
    } catch {
      setError('Access was not allowed. Allow the camera and microphone for this site to record.')
      return
    }
    setStream(live.current)
    chunks.current = []
    const rec = new MediaRecorder(live.current, { mimeType: mime, ...bitrates })
    rec.ondataavailable = e => { if (e.data.size > 0) chunks.current.push(e.data) }
    rec.onstop = () => {
      const blob = new Blob(chunks.current, { type: mime.split(';')[0] })
      setRecording(false)
      if (blob.size === 0) return
      if (blob.size > MAX_UPLOAD_BYTES) {
        setError(`That came out at ${humanSize(blob.size)}, over the ${humanSize(MAX_UPLOAD_BYTES)} limit. Record a shorter one.`)
        return
      }
      onDone(blob)
    }
    recorder.current = rec
    rec.start(1000)
    setSeconds(0)
    setRecording(true)
    const began = Date.now()
    timer.current = window.setInterval(() => {
      const s = (Date.now() - began) / 1000
      setSeconds(s)
      if (s >= maxSeconds) release()
    }, 250)
  }

  return { recording, seconds, error, stream, start, stop: release }
}

function RecordingBar({ seconds, max, onStop }: { seconds: number; max: number; onStop: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-cyrixRed-200 bg-cyrixRed-50 px-3 py-2">
      <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-cyrixRed-600" />
      <span className="font-mono text-sm tabular-nums text-cyrixRed-900">{clock(seconds)} / {clock(max)}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-cyrixRed-100">
        <div className="h-full bg-cyrixRed-500" style={{ width: `${Math.min(100, (seconds / max) * 100)}%` }} />
      </div>
      <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={onStop}>
        <Square className="h-3.5 w-3.5" /> Stop
      </button>
    </div>
  )
}

/** A URL for a blob that is revoked when the blob changes or the component goes. */
function useBlobUrl(blob: Blob | null) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!blob) { setUrl(null); return }
    const u = URL.createObjectURL(blob)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob])
  return url
}

/**
 * An optional short video of the fault — a flicker, a noise, an error that
 * comes and goes — recorded here rather than by the camera app, because a
 * camera clip is 60 MB a minute and this one is about 2 MB for 30 seconds.
 * Deleted when the ticket closes.
 */
export function VideoRecorder({ video, onChange }: { video: Blob | null; onChange: (next: Blob | null) => void }) {
  const r = useRecorder({
    maxSeconds: MAX_VIDEO_SECONDS,
    pickMime: pickVideoRecorderMime,
    constraints: {
      audio: true,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: VIDEO_WIDTH },
        height: { ideal: VIDEO_HEIGHT },
        frameRate: { ideal: VIDEO_FPS, max: VIDEO_FPS },
      },
    },
    bitrates: { videoBitsPerSecond: VIDEO_BITS_PER_SECOND, audioBitsPerSecond: 32_000 },
    onDone: onChange,
  })
  const url = useBlobUrl(video)
  const preview = useRef<HTMLVideoElement>(null)

  // The live camera, shown while recording, so the fault is in frame.
  useEffect(() => {
    if (preview.current) preview.current.srcObject = r.stream
  }, [r.stream])

  return (
    <div className="space-y-2">
      {r.recording ? (
        <>
          <video ref={preview} autoPlay muted playsInline className="aspect-video w-full max-w-sm rounded-lg bg-black object-cover" />
          <RecordingBar seconds={r.seconds} max={MAX_VIDEO_SECONDS} onStop={r.stop} />
        </>
      ) : video && url ? (
        <div className="space-y-2">
          <video controls playsInline src={url} className="aspect-video w-full max-w-sm rounded-lg bg-black" />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-400">{humanSize(video.size)}</span>
            <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => onChange(null)}>
              <Trash2 className="h-3.5 w-3.5" /> Record again
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn-secondary" onClick={() => void r.start()}>
          <Video className="h-4 w-4" /> Record a video
          <span className="text-xs text-ink-400">optional, up to {MAX_VIDEO_SECONDS} seconds</span>
        </button>
      )}
      {r.error && <p className="text-xs text-amber-700">{r.error}</p>}
    </div>
  )
}

/**
 * A voice note of up to a minute, to explain what a photo cannot.
 *
 * Stops on its own at 60 seconds. Recorded at speech quality, so the whole
 * minute is under 200 KB. Played back before it is sent, and recorded
 * again if it came out wrong.
 */
export function VoiceRecorder({ voice, onChange }: { voice: Blob | null; onChange: (next: Blob | null) => void }) {
  const r = useRecorder({
    maxSeconds: MAX_VOICE_SECONDS,
    pickMime: pickRecorderMime,
    constraints: { audio: true },
    bitrates: { audioBitsPerSecond: VOICE_BITS_PER_SECOND },
    onDone: onChange,
  })
  const url = useBlobUrl(voice)

  return (
    <div className="space-y-2">
      {r.recording ? (
        <RecordingBar seconds={r.seconds} max={MAX_VOICE_SECONDS} onStop={r.stop} />
      ) : voice && url ? (
        <div className="flex flex-wrap items-center gap-2">
          <audio controls src={url} className="h-10 max-w-full" />
          <span className="text-xs text-ink-400">{humanSize(voice.size)}</span>
          <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={() => onChange(null)}>
            <Trash2 className="h-3.5 w-3.5" /> Record again
          </button>
        </div>
      ) : (
        <button type="button" className="btn-secondary" onClick={() => void r.start()}>
          <Mic className="h-4 w-4" /> Record a voice note
          <span className="text-xs text-ink-400">up to 1 minute</span>
        </button>
      )}
      {r.error && <p className="text-xs text-amber-700">{r.error}</p>}
    </div>
  )
}
