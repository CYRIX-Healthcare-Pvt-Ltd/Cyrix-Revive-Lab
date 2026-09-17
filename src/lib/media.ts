/**
 * Photos, the video and the voice note, made small before they leave the phone.
 *
 * A phone photo is 3–6 MB and 4000px wide, and a phone video is 60 MB a
 * minute; a Revive Lab engineer looking at a burnt capacitor needs a
 * fraction of either. So nothing is sent as the camera made it:
 *
 *   photo   at most 1280px on its long side, JPEG, re-encoded until it is
 *           under 250 KB — typically 100–200 KB
 *   video   recorded here, not by the camera app: 640×480, 24 fps, about
 *           500 kbps, at most 30 seconds — about 2 MB for the full clip,
 *           and deleted once the ticket closes
 *   voice   speech quality, 24 kbps — about 180 KB for the full minute
 *
 * Everything goes to Storage, not into a table as base64, which would be a
 * third larger again and sit in the database every module shares.
 */

/** The largest side a photo is sent at. Enough to read a part number. */
export const MAX_PHOTO_SIDE = 1280
/** A photo is re-encoded, a little rougher each time, until it fits this. */
export const PHOTO_TARGET_BYTES = 250 * 1024
/** How many photos a ticket has room for — the storage rules allow image-1 and image-2. */
export const MAX_PHOTOS = 2

export const MAX_VOICE_SECONDS = 60
export const VOICE_BITS_PER_SECOND = 24_000

export const MAX_VIDEO_SECONDS = 30
export const VIDEO_WIDTH = 640
export const VIDEO_HEIGHT = 480
export const VIDEO_FPS = 24
export const VIDEO_BITS_PER_SECOND = 500_000

/**
 * A video chosen from the gallery is redrawn here, at the size one recorded
 * here would be — a phone's own video is 1080p and 60 MB a minute.
 */
export const VIDEO_MAX_SIDE = VIDEO_WIDTH

/** A frame scaled to fit `max` on its long side, in even pixels as video encoders need, never enlarged. */
export function fitVideo(width: number, height: number, max = VIDEO_MAX_SIDE): { width: number; height: number } {
  const fit = fitWithin(width, height, max)
  if (!fit.width || !fit.height) return { width: 0, height: 0 }
  const even = (n: number) => Math.max(2, n - (n % 2))
  return { width: even(fit.width), height: even(fit.height) }
}

/**
 * How much of a chosen video is kept: all of it, or the first `max`
 * seconds. Half a second of grace, so a 30.2-second clip is not called cut.
 */
export function keptSeconds(duration: number, max = MAX_VIDEO_SECONDS): { seconds: number; trimmed: boolean } {
  if (!Number.isFinite(duration) || duration <= 0) return { seconds: max, trimmed: false }
  return duration > max + 0.5 ? { seconds: max, trimmed: true } : { seconds: duration, trimmed: false }
}
/** The bucket's ceiling. A browser that ignored the bitrate can pass it. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** Width and height scaled to fit within `max` on the long side, never enlarged. */
export function fitWithin(width: number, height: number, max = MAX_PHOTO_SIDE): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/**
 * The qualities a photo is tried at, best first. The first that lands under
 * the target is kept; if none does, the last one is — a rough photo that
 * arrives beats a sharp one refused.
 */
export const PHOTO_QUALITIES = [0.72, 0.6, 0.5, 0.4] as const

/**
 * The file extension for a type, matching the names the bucket allows:
 * image-1.jpg, video.webm, voice.m4a …
 */
export function extensionFor(mime: string): string {
  const type = mime.split(';')[0].trim().toLowerCase()
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'video/webm': 'webm',
    'video/mp4': 'mp4',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/aac': 'aac',
  }
  return map[type] ?? ''
}

const firstSupported = (candidates: string[], isSupported: (mime: string) => boolean): string | null =>
  candidates.find(m => {
    try { return isSupported(m) } catch { return false }
  }) ?? null

/**
 * The audio format this browser can record, best first. Chrome and Android
 * record Opus in WebM, Firefox in Ogg, and every iPhone only in MP4.
 */
export function pickRecorderMime(isSupported: (mime: string) => boolean): string | null {
  return firstSupported(['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/aac'], isSupported)
}

/**
 * The video format this browser can record.
 *
 * WebM where it can — except on WebKit, which is Safari and every browser
 * on an iPhone. WebKit records WebM too, but its VP9 would not decode in
 * Chrome at all: a video sent from an iPhone was a black box with an error
 * for a Revive Lab on Chrome. Its MP4 plays everywhere, so WebKit records
 * that. Chrome and Firefox keep WebM, which they play back cleanly.
 */
export function pickVideoRecorderMime(isSupported: (mime: string) => boolean, webkit = false): string | null {
  const webm = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  const mp4 = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4']
  return firstSupported(webkit ? [...mp4, ...webm] : [...webm, ...mp4], isSupported)
}

/** Safari, or any browser on an iPhone or iPad — all of them WebKit underneath. */
export function isWebKit(nav: { userAgent: string; platform?: string; maxTouchPoints?: number }): boolean {
  const ua = nav.userAgent
  // iPadOS asks for desktop pages and says it is a Mac; a Mac has no touch screen.
  const apple = /iPad|iPhone|iPod/.test(ua) || (nav.platform === 'MacIntel' && (nav.maxTouchPoints ?? 0) > 1)
  const safari = /AppleWebKit/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Android/.test(ua)
  return apple || safari
}

/** "0:07", "1:00". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** "240 KB", "1.2 MB". */
export function humanSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Redraws a photo small, as a JPEG under the target size.
 *
 * createImageBitmap honours the photo's EXIF orientation where the browser
 * supports the option, so a portrait shot does not arrive lying on its side.
 */
export async function compressPhoto(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions)
  } catch {
    throw new Error('That file could not be read as a photo.')
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const g = canvas.getContext('2d')
  if (!g) throw new Error('This browser cannot prepare photos.')
  g.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  let blob: Blob | null = null
  for (const quality of PHOTO_QUALITIES) {
    blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (blob && blob.size <= PHOTO_TARGET_BYTES) break
  }
  if (!blob) throw new Error('That photo could not be prepared.')
  return blob
}
