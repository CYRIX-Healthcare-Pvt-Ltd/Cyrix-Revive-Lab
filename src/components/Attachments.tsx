import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Camera, CheckCircle2, Mic, Square, Trash2, Video, X } from 'lucide-react'
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

/** A value and its setter, the way a form holds a field. */
interface Held<T> {
  value: T
  onChange: (next: T) => void
}

/**
 * Photos, a video and a voice note — three tiles in one row on a computer,
 * one under another on a phone.
 *
 * The tile is the control: tap it to add a photo, or to start a recording
 * and again to stop it. What was taken shows under its own tile. A kind that
 * is left out gets no tile — the ticket page leaves out what the ticket
 * already has.
 *
 * On a phone the photo tile opens the camera straight away; on a computer,
 * the file picker. Every photo is shrunk in the browser before it is kept,
 * so what shows here is exactly what will be sent.
 */
export function MediaCapture({ photos, video, voice }: {
  photos?: Held<PendingPhoto[]> & { max?: number }
  video?: Held<Blob | null>
  voice?: Held<Blob | null>
}) {
  const input = useRef<HTMLInputElement>(null)
  const [preparing, setPreparing] = useState(false)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const taken = photos?.value ?? []
  const max = photos?.max ?? MAX_PHOTOS

  // Object URLs are memory until revoked: give back whatever is held when this goes.
  const held = useRef(taken)
  held.current = taken
  useEffect(() => () => held.current.forEach(p => URL.revokeObjectURL(p.preview)), [])

  const videoRec = useRecorder({
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
    onDone: blob => video?.onChange(blob),
  })
  const voiceRec = useRecorder({
    maxSeconds: MAX_VOICE_SECONDS,
    pickMime: pickRecorderMime,
    constraints: { audio: true },
    bitrates: { audioBitsPerSecond: VOICE_BITS_PER_SECOND },
    onDone: blob => voice?.onChange(blob),
  })
  const videoUrl = useBlobUrl(video?.value ?? null)
  const voiceUrl = useBlobUrl(voice?.value ?? null)

  // The live camera while recording, so the fault is in frame.
  const viewfinder = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    if (viewfinder.current) viewfinder.current.srcObject = videoRec.stream
  }, [videoRec.stream])

  /*
    One thing at a time. Both recordings want the microphone, and the camera
    app a photo opens on a phone would cut a video off.
  */
  const busy = preparing || videoRec.active || voiceRec.active

  const addPhotos = async (files: FileList | null) => {
    if (!photos || !files?.length) return
    setPhotoError(null); setPreparing(true)
    try {
      const room = max - taken.length
      const made: PendingPhoto[] = []
      for (const f of [...files].slice(0, room)) {
        const blob = await compressPhoto(f)
        made.push({ blob, preview: URL.createObjectURL(blob) })
      }
      photos.onChange([...taken, ...made])
      if (files.length > room) setPhotoError(`Only ${max} ${max === 1 ? 'photo fits' : 'photos fit'} — the rest were left out.`)
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : 'That photo could not be added.')
    } finally {
      setPreparing(false)
    }
  }

  const dropPhoto = (i: number) => {
    if (!photos) return
    URL.revokeObjectURL(taken[i].preview)
    photos.onChange(taken.filter((_, j) => j !== i))
  }

  const cells: Array<{ key: string; tile: ReactNode; below: ReactNode }> = []

  if (photos) {
    const noun = max === 1 ? 'Photo' : 'Photos'
    cells.push({
      key: 'photos',
      tile: taken.length >= max ? (
        <Tile tone="done" icon={<CheckCircle2 className="h-5 w-5" />} title={noun} hint={`${taken.length} of ${max}`} />
      ) : (
        <Tile
          icon={preparing ? <Spinner className="h-5 w-5" /> : <Camera className="h-5 w-5" />}
          title={preparing ? 'Preparing…' : noun}
          hint={`${taken.length} of ${max}`}
          label={`Add a photo, ${taken.length} of ${max} added`}
          onClick={() => input.current?.click()}
          disabled={busy}
        />
      ),
      below: (taken.length > 0 || photoError) && (
        <div className="space-y-1.5">
          {taken.length > 0 && (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-2">
              {taken.map((p, i) => (
                <div key={p.preview} className="relative aspect-square overflow-hidden rounded-lg border border-ink-200">
                  <img src={p.preview} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => dropPhoto(i)}
                    disabled={busy}
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
            </div>
          )}
          {photoError && <p className="text-xs text-amber-700">{photoError}</p>}
        </div>
      ),
    })
  }

  if (video) {
    cells.push({
      key: 'video',
      tile: recorderTile(videoRec, video.value, MAX_VIDEO_SECONDS, {
        icon: <Video className="h-5 w-5" />,
        title: 'Video',
        hint: `up to ${MAX_VIDEO_SECONDS} s`,
        label: `Record a video, up to ${MAX_VIDEO_SECONDS} seconds`,
        disabled: busy,
      }),
      below: (videoRec.recording || (video.value && videoUrl) || videoRec.error) && (
        <div className="space-y-1.5">
          {videoRec.recording ? (
            <div className="relative overflow-hidden rounded-lg bg-black">
              <video ref={viewfinder} autoPlay muted playsInline className="aspect-video w-full object-cover" />
              <div className="absolute inset-x-2 bottom-2 flex items-center justify-between gap-2">
                <span className="rounded bg-black/60 px-1.5 py-0.5 font-mono text-xs tabular-nums text-white">
                  {clock(videoRec.seconds)} / {clock(MAX_VIDEO_SECONDS)}
                </span>
                <button
                  type="button"
                  onClick={videoRec.stop}
                  className="inline-flex items-center gap-1 rounded-full bg-cyrixRed-600 px-3 py-1 text-xs font-medium text-white"
                >
                  <Square className="h-3 w-3" /> Stop
                </button>
              </div>
            </div>
          ) : video.value && videoUrl ? (
            <>
              <video controls playsInline src={videoUrl} className="aspect-video w-full rounded-lg bg-black" />
              <RemoveRecording size={video.value.size} onClick={() => video.onChange(null)} disabled={busy} />
            </>
          ) : null}
          {videoRec.error && <p className="text-xs text-amber-700">{videoRec.error}</p>}
        </div>
      ),
    })
  }

  if (voice) {
    cells.push({
      key: 'voice',
      tile: recorderTile(voiceRec, voice.value, MAX_VOICE_SECONDS, {
        icon: <Mic className="h-5 w-5" />,
        title: 'Voice note',
        hint: `up to ${MAX_VOICE_SECONDS / 60} min`,
        label: `Record a voice note, up to ${MAX_VOICE_SECONDS / 60} minute`,
        disabled: busy,
      }),
      below: ((voice.value && voiceUrl) || voiceRec.error) && (
        <div className="space-y-1.5">
          {voice.value && voiceUrl && (
            <>
              <audio controls src={voiceUrl} className="h-10 w-full" />
              <RemoveRecording size={voice.value.size} onClick={() => voice.onChange(null)} disabled={busy} />
            </>
          )}
          {voiceRec.error && <p className="text-xs text-amber-700">{voiceRec.error}</p>}
        </div>
      ),
    })
  }

  return (
    <div>
      {/*
        One grid. On a phone it is a single column, and what was taken follows
        its own tile. Wider, the tiles take the first row, three across, and
        what was taken sits in the second row under its tile.
      */}
      <div className="grid gap-2 sm:grid-cols-3 sm:gap-3">
        {cells.map((c, i) => (
          <Fragment key={c.key}>
            <div className={TILE_PLACE[i]}>{c.tile}</div>
            {c.below && <div className={BELOW_PLACE[i]}>{c.below}</div>}
          </Fragment>
        ))}
      </div>

      {photos && (
        <input
          ref={input}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={e => { void addPhotos(e.target.files); e.target.value = '' }}
        />
      )}
    </div>
  )
}

// Whole class names, so Tailwind finds them.
const TILE_PLACE = ['sm:col-start-1 sm:row-start-1', 'sm:col-start-2 sm:row-start-1', 'sm:col-start-3 sm:row-start-1']
const BELOW_PLACE = ['sm:col-start-1 sm:row-start-2', 'sm:col-start-2 sm:row-start-2', 'sm:col-start-3 sm:row-start-2']

/** Idle, starting, recording or recorded — the one tile a recorder shows. */
function recorderTile(
  r: Recorder,
  value: Blob | null,
  maxSeconds: number,
  idle: { icon: ReactNode; title: string; hint: string; label: string; disabled: boolean },
) {
  if (r.recording) {
    return (
      <Tile
        tone="live"
        icon={<span className="flex h-5 w-5 items-center justify-center"><span className="h-2.5 w-2.5 rounded-full bg-cyrixRed-600 motion-safe:animate-pulse" /></span>}
        title="Stop"
        hint={`${clock(r.seconds)} / ${clock(maxSeconds)}`}
        label={`Stop recording, ${clock(r.seconds)} of ${clock(maxSeconds)}`}
        progress={r.seconds / maxSeconds}
        onClick={r.stop}
      />
    )
  }
  if (value) {
    return (
      <Tile
        tone="done"
        icon={<CheckCircle2 className="h-5 w-5" />}
        title={idle.title}
        hint={r.seconds > 0 ? clock(r.seconds) : humanSize(value.size)}
      />
    )
  }
  return (
    <Tile
      icon={r.starting ? <Spinner className="h-5 w-5" /> : idle.icon}
      title={r.starting ? 'Starting…' : idle.title}
      hint={idle.hint}
      label={idle.label}
      onClick={() => void r.start()}
      disabled={idle.disabled}
    />
  )
}

/**
 * One tile. Waiting, it is dashed — a space to fill. Recording, it is red
 * and fills along its foot. Done, it is green, and no longer a button: what
 * was taken is under it, with its own Remove.
 *
 * On a phone it is a full-width bar, icon and name on the left and the
 * limit on the right, so the three stacked cost little of the screen;
 * wider, a square-ish tile with everything centred.
 */
function Tile({ icon, title, hint, tone = 'idle', progress, label, onClick, disabled }: {
  icon: ReactNode
  title: string
  hint: string
  tone?: 'idle' | 'live' | 'done'
  progress?: number
  label?: string
  onClick?: () => void
  disabled?: boolean
}) {
  const shape = clsx(
    'relative flex min-h-12 w-full items-center gap-3 overflow-hidden rounded-lg border px-3 py-2.5 text-left',
    'sm:h-24 sm:flex-col sm:justify-center sm:gap-1 sm:px-1 sm:py-0 sm:text-center',
  )
  const inner = (
    <>
      <span className="flex shrink-0 items-center">{icon}</span>
      <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2 sm:flex-none sm:flex-col sm:items-center sm:gap-1">
        <span className="text-sm font-medium leading-tight sm:text-xs">{title}</span>
        <span className="text-xs leading-tight tabular-nums opacity-75 sm:text-[11px]">{hint}</span>
      </span>
      {progress !== undefined && (
        <span className="absolute inset-x-0 bottom-0 h-1 bg-cyrixRed-100">
          <span
            className="block h-full bg-cyrixRed-600 transition-[width] duration-300 ease-linear"
            style={{ width: `${Math.min(100, progress * 100)}%` }}
          />
        </span>
      )}
    </>
  )

  if (tone === 'done') {
    return <div className={clsx(shape, 'border-emerald-200 bg-emerald-50 text-emerald-800')}>{inner}</div>
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={clsx(
        shape,
        'transition-[transform,border-color,color] duration-150 ease-out motion-safe:active:scale-[0.97]',
        'disabled:cursor-not-allowed disabled:opacity-50',
        tone === 'live'
          ? 'border-cyrixRed-200 bg-cyrixRed-50 text-cyrixRed-800'
          : 'border-dashed border-ink-300 text-ink-600 enabled:hover:border-ink-500 enabled:hover:text-ink-900',
      )}
    >
      {inner}
    </button>
  )
}

function RemoveRecording({ size, onClick, disabled }: { size: number; onClick: () => void; disabled: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-xs" onClick={onClick} disabled={disabled}>
        <Trash2 className="h-3.5 w-3.5" /> Remove
      </button>
      <span className="text-xs text-ink-400">{humanSize(size)}</span>
    </div>
  )
}

/* ------------------------------------------------------------------ */

type Recorder = ReturnType<typeof useRecorder>

/**
 * What both recorders share: asking for the microphone (and camera),
 * counting up to the limit, stopping on their own, and always giving the
 * devices back — leaving a page mid-recording must not keep the camera on,
 * and neither must leaving it while the browser is still asking.
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
  const [starting, setStarting] = useState(false)
  const [recording, setRecording] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const timer = useRef<number | null>(null)
  const live = useRef<MediaStream | null>(null)
  const mounted = useRef(true)

  const release = () => {
    if (timer.current) { window.clearInterval(timer.current); timer.current = null }
    if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop()
    live.current?.getTracks().forEach(t => t.stop())
    live.current = null
    setStream(null)
  }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; release() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const start = async () => {
    if (starting || recording) return
    setError(null)
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot record here.')
      return
    }
    const mime = pickMime(m => MediaRecorder.isTypeSupported(m))
    if (!mime) { setError('This browser cannot record in a format that can be sent.'); return }

    setStarting(true)
    let got: MediaStream
    try {
      got = await navigator.mediaDevices.getUserMedia(constraints)
    } catch {
      setStarting(false)
      setError('Access was not allowed. Allow the camera and microphone for this site to record.')
      return
    }
    setStarting(false)
    // Gone while the browser was asking: hand the devices straight back.
    if (!mounted.current) { got.getTracks().forEach(t => t.stop()); return }
    live.current = got

    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(got, { mimeType: mime, ...bitrates })
      chunks.current = []
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
      rec.start(1000)
    } catch {
      release()
      setError('This browser cannot record in a format that can be sent.')
      return
    }
    recorder.current = rec
    setStream(got)
    setSeconds(0)
    setRecording(true)
    const began = Date.now()
    timer.current = window.setInterval(() => {
      const s = (Date.now() - began) / 1000
      setSeconds(s)
      if (s >= maxSeconds) release()
    }, 250)
  }

  return { starting, recording, active: starting || recording, seconds, error, stream, start, stop: release }
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
