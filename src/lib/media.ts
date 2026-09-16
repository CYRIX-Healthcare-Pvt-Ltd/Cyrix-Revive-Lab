/**
 * Photos and the voice note, made small before they leave the phone.
 *
 * A phone photo is 3–6 MB and 4000px wide; a coordinator looking at a
 * burnt capacitor needs a fraction of that. So a photo is redrawn at most
 * 1600px on its long side as a JPEG before it is sent — typically 150–300
 * KB — and the voice note is recorded at speech quality, about 250 KB for
 * the full minute. Files go to Storage, not into a table as base64, which
 * would be a third larger again and sit in the database every module shares.
 */

/** The largest side a photo is sent at. Plenty to read a part number. */
export const MAX_PHOTO_SIDE = 1600
/** How long a voice note may run. */
export const MAX_VOICE_SECONDS = 60
/** How many photos a ticket has room for — the storage rules allow image-1 and image-2. */
export const MAX_PHOTOS = 2

/** Width and height scaled to fit within `max` on the long side, never enlarged. */
export function fitWithin(width: number, height: number, max = MAX_PHOTO_SIDE): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, max / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

/**
 * The file extension for a type, matching the names the bucket allows:
 * image-1.jpg, voice.webm, voice.m4a …
 */
export function extensionFor(mime: string): string {
  const type = mime.split(';')[0].trim().toLowerCase()
  const map: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/mp4': 'm4a',
    'audio/mpeg': 'mp3',
    'audio/aac': 'aac',
  }
  return map[type] ?? ''
}

/**
 * The recording format this browser can make, best first.
 *
 * Chrome and Android record Opus in WebM, Firefox in Ogg, and Safari —
 * every iPhone — only in MP4. Asking for one it cannot do throws, so the
 * list is checked in order and the first it supports wins.
 */
export function pickRecorderMime(isSupported: (mime: string) => boolean): string | null {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/aac']
  return candidates.find(m => {
    try { return isSupported(m) } catch { return false }
  }) ?? null
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
 * Redraws a photo small, as a JPEG.
 *
 * createImageBitmap honours the photo's EXIF orientation where the browser
 * supports the option, so a portrait shot does not arrive lying on its side.
 * Anything that cannot be decoded is refused with a sentence rather than
 * uploaded as it is.
 */
export async function compressPhoto(file: Blob, quality = 0.8): Promise<Blob> {
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
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality))
  if (!blob) throw new Error('That photo could not be prepared.')
  return blob
}
