import { fitVideo, keptSeconds, MAX_VIDEO_SECONDS, VIDEO_BITS_PER_SECOND, VIDEO_FPS } from './media'
import { withDuration } from './webm'

/**
 * A video from the gallery, made into one the app could have recorded.
 *
 * A phone's own video is the wrong thing to send: 1080p, 60 MB a minute, and
 * from an iPhone in HEVC, which Chrome on a Revive Lab's computer may not
 * play at all. So it is played here, out of sight, drawn frame by frame onto
 * a 640px canvas, and recorded again the way the app records — the same
 * format, bitrate and 30-second limit. What comes out plays everywhere and
 * is about 2 MB. It takes as long as the part being kept, so the tile counts
 * it along.
 *
 * The sound goes through an AudioContext into the recording, never to the
 * speaker. That context has to be made during the tap that opened the
 * gallery — a browser only lets sound start from a tap — so the caller makes
 * it and hands it in. Where the sound still cannot be had, the video is
 * kept without it rather than refused.
 */
export async function shrinkVideo(file: Blob, opts: {
  mime: string
  audio: AudioContext | null
  onProgress: (done: number, of: number) => void
  signal: AbortSignal
}): Promise<{ blob: Blob; seconds: number; trimmed: boolean; original: number }> {
  const url = URL.createObjectURL(file)
  const v = document.createElement('video')
  v.playsInline = true
  v.preload = 'auto'
  // In the page, where every browser keeps decoding it, but never seen.
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none'
  v.src = url
  document.body.appendChild(v)

  let stream: MediaStream | null = null
  let source: MediaElementAudioSourceNode | null = null
  let recorder: MediaRecorder | null = null
  const cleanUp = () => {
    if (recorder && recorder.state !== 'inactive') recorder.stop()
    v.pause()
    source?.disconnect()
    stream?.getTracks().forEach(t => t.stop())
    v.removeAttribute('src')
    v.load()
    v.remove()
    URL.revokeObjectURL(url)
  }

  try {
    await new Promise<void>((resolve, reject) => {
      v.onloadedmetadata = () => resolve()
      v.onerror = () => reject(new Error('That video could not be opened here. Record one instead.'))
    })
    // A WebM from a browser or a messaging app may not say how long it is.
    // Asking for a moment far past the end makes the browser find the end.
    if (v.duration === Infinity) {
      await new Promise<void>(resolve => {
        const found = () => { if (Number.isFinite(v.duration)) { v.removeEventListener('durationchange', found); resolve() } }
        v.addEventListener('durationchange', found)
        v.currentTime = 1e101
        setTimeout(() => { v.removeEventListener('durationchange', found); resolve() }, 3000)
      })
      v.currentTime = 0
      await new Promise<void>(resolve => {
        if (v.readyState >= 2 && v.currentTime === 0) { resolve(); return }
        v.addEventListener('seeked', () => resolve(), { once: true })
        setTimeout(resolve, 3000)
      })
    }
    const original = v.duration
    const keep = keptSeconds(original)
    const { width, height } = fitVideo(v.videoWidth, v.videoHeight)
    if (!width || !height) throw new Error('That file has no picture in it.')

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const g = canvas.getContext('2d')
    if (!g || typeof canvas.captureStream !== 'function') {
      throw new Error('This browser cannot prepare a video. Record one instead.')
    }
    stream = canvas.captureStream(VIDEO_FPS)

    if (opts.audio) {
      try {
        source = opts.audio.createMediaElementSource(v)
        const out = opts.audio.createMediaStreamDestination()
        source.connect(out)
        out.stream.getAudioTracks().forEach(t => stream!.addTrack(t))
      } catch {
        // No sound in it rather than no video.
      }
    }

    recorder = new MediaRecorder(stream, {
      mimeType: opts.mime, videoBitsPerSecond: VIDEO_BITS_PER_SECOND, audioBitsPerSecond: 32_000,
    })
    const chunks: Blob[] = []
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
    const rec = recorder
    const stopped = new Promise<void>(resolve => { rec.onstop = () => resolve() })

    g.fillStyle = '#000'
    g.fillRect(0, 0, width, height)
    recorder.start(1000)
    const began = performance.now()
    try {
      await v.play()
    } catch {
      // Sound may not start without a tap; a silent video still shows the fault.
      v.muted = true
      await v.play()
    }

    await new Promise<void>((resolve, reject) => {
      const finish = () => { document.removeEventListener('visibilitychange', left); resolve() }
      const fail = (err: Error) => { document.removeEventListener('visibilitychange', left); reject(err) }
      // A hidden page stops drawing, and what was recorded would freeze.
      const left = () => {
        if (document.hidden) fail(new Error('Preparing stopped when the screen was left. Choose the video again and keep this screen open.'))
      }
      document.addEventListener('visibilitychange', left)
      v.onended = finish
      const draw = () => {
        if (opts.signal.aborted) { fail(new DOMException('Stopped', 'AbortError')); return }
        g.drawImage(v, 0, 0, width, height)
        opts.onProgress(Math.min(v.currentTime, keep.seconds), keep.seconds)
        if (v.ended || v.currentTime >= keep.seconds) { finish(); return }
        requestAnimationFrame(draw)
      }
      requestAnimationFrame(draw)
    })

    const elapsed = performance.now() - began
    v.pause()
    rec.stop()
    await stopped
    const raw = new Blob(chunks, { type: opts.mime.split(';')[0] })
    if (raw.size === 0) throw new Error('That video could not be prepared. Record one instead.')
    // Chrome leaves the length out of what it records, as with a recording made here (webm.ts).
    const blob = await withDuration(raw, elapsed)
    return {
      blob,
      seconds: Math.min(elapsed / 1000, MAX_VIDEO_SECONDS),
      trimmed: keep.trimmed,
      original: Number.isFinite(original) ? original : 0,
    }
  } finally {
    cleanUp()
  }
}
