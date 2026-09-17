/**
 * Writes a recording's length into its WebM file.
 *
 * Chrome's recorder streams a WebM out as it goes, so it never goes back to
 * fill in how long the file is. Players then have no length to work with:
 * the time shows 0:00, the bar cannot be dragged, and a phone can stop
 * part-way through. The length is one small element in the file's Info
 * section; this adds it, before the file is previewed or sent.
 *
 * Adding it moves everything after the Info along by a few bytes, and
 * Chrome ends the file with Cues — an index of where each cluster starts,
 * by position — so those positions move by the same amount.
 *
 * Anything laid out differently — an MP4 from Safari, a file with a seek
 * index at the front, a Segment of known size — comes back exactly as it
 * was. A file that plays without its length is better than a file this broke.
 */

const EBML = 0x1a45dfa3
const SEGMENT = 0x18538067
const SEEK_HEAD = 0x114d9b74
const INFO = 0x1549a966
const TIMECODE_SCALE = 0x2ad7b1
const DURATION = 0x4489
const CLUSTER = 0x1f43b675
const CUES = 0x1c53bb6b
const CUE_POINT = 0xbb
const CUE_TRACK_POSITIONS = 0xb7
const CUE_CLUSTER_POSITION = 0xf1

/** How many bytes a variable-length number takes, from its first byte. */
function vintLength(first: number): number {
  for (let len = 1; len <= 8; len++) if (first & (0x80 >> (len - 1))) return len
  return 0
}

function readId(b: Uint8Array, at: number): { id: number; len: number } | null {
  if (at >= b.length) return null
  const len = vintLength(b[at])
  if (len < 1 || len > 4 || at + len > b.length) return null
  let id = 0
  for (let i = 0; i < len; i++) id = id * 256 + b[at + i]
  return { id, len }
}

function readSize(b: Uint8Array, at: number): { size: number; len: number; unknown: boolean } | null {
  if (at >= b.length) return null
  const len = vintLength(b[at])
  if (len < 1 || len > 8 || at + len > b.length) return null
  let size = b[at] & (0xff >> len)
  let unknown = size === 0xff >> len
  for (let i = 1; i < len; i++) {
    size = size * 256 + b[at + i]
    if (b[at + i] !== 0xff) unknown = false
  }
  return { size, len, unknown }
}

/** A size written in exactly `len` bytes, or null if it does not fit. */
function sizeBytes(size: number, len: number): Uint8Array | null {
  if (size >= 2 ** (7 * len) - 1) return null
  const out = new Uint8Array(len)
  let v = size
  for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256) }
  out[0] |= 0x80 >> (len - 1)
  return out
}

/** Each element in [from, to): its id and where its data is. False if the bytes are not elements. */
function eachElement(
  b: Uint8Array, from: number, to: number,
  visit: (id: number, dataAt: number, size: number) => boolean,
): boolean {
  for (let p = from; p < to;) {
    const el = readId(b, p)
    const size = el && readSize(b, p + el.len)
    if (!el || !size || size.unknown) return false
    const dataAt = p + el.len + size.len
    if (dataAt + size.size > to) return false
    if (!visit(el.id, dataAt, size.size)) return false
    p = dataAt + size.size
  }
  return true
}

/**
 * Moves every cluster position in the Cues that end the file by `shift`.
 * False when there is something there that is not a whole Cues element, or
 * a position that would no longer fit in its bytes.
 */
function shiftCues(b: Uint8Array, shift: number): boolean {
  let at = -1
  for (let i = b.length - 4; i >= 0; i--) {
    if (b[i] === 0x1c && b[i + 1] === 0x53 && b[i + 2] === 0xbb && b[i + 3] === 0x6b) { at = i; break }
  }
  if (at < 0) return true // no index to move

  const el = readId(b, at)
  const size = el && readSize(b, at + el.len)
  if (!el || el.id !== CUES || !size || size.unknown) return false
  const start = at + el.len + size.len
  if (start + size.size !== b.length) return false

  return eachElement(b, start, b.length, (id, dataAt, len) =>
    id === CUE_POINT && eachElement(b, dataAt, dataAt + len, (id2, at2, len2) =>
      id2 !== CUE_TRACK_POSITIONS || eachElement(b, at2, at2 + len2, (id3, at3, len3) => {
        if (id3 !== CUE_CLUSTER_POSITION) return true
        if (len3 < 1 || len3 > 6) return false
        let v = 0
        for (let i = 0; i < len3; i++) v = v * 256 + b[at3 + i]
        v += shift
        if (v >= 256 ** len3) return false
        for (let i = len3 - 1; i >= 0; i--) { b[at3 + i] = v % 256; v = Math.floor(v / 256) }
        return true
      })))
}

/** The same bytes with the length in, or null to leave the file alone. */
export function withDurationBytes(b: Uint8Array, ms: number): Uint8Array<ArrayBuffer> | null {
  if (!(ms > 0) || !Number.isFinite(ms)) return null

  const head = readId(b, 0)
  const headSize = head && readSize(b, head.len)
  if (!head || head.id !== EBML || !headSize || headSize.unknown) return null

  const segAt = head.len + headSize.len + headSize.size
  const seg = readId(b, segAt)
  const segSize = seg && readSize(b, segAt + seg.len)
  // A recorder does not know the Segment's size either. One that is written
  // down would have to grow too — not a file a browser recorder makes.
  if (!seg || seg.id !== SEGMENT || !segSize || !segSize.unknown) return null

  // The Segment's children, up to the first Cluster: the Info is among them.
  for (let at = segAt + seg.len + segSize.len; at < b.length;) {
    const el = readId(b, at)
    const size = el && readSize(b, at + el.len)
    if (!el || !size || size.unknown) return null
    if (el.id === CLUSTER || el.id === SEEK_HEAD) return null
    const dataAt = at + el.len + size.len
    const end = dataAt + size.size
    if (end > b.length) return null

    if (el.id !== INFO) { at = end; continue }

    let scale = 1_000_000
    let durationAt = -1
    let durationLen = 0
    const readable = eachElement(b, dataAt, end, (id, childAt, childLen) => {
      if (id === TIMECODE_SCALE) {
        scale = 0
        for (let i = 0; i < childLen; i++) scale = scale * 256 + b[childAt + i]
      }
      if (id === DURATION) { durationAt = childAt; durationLen = childLen }
      return true
    })
    if (!readable || !(scale > 0)) return null
    const value = (ms * 1_000_000) / scale

    // Already there: fill it in only if it is empty. Nothing moves.
    if (durationAt >= 0) {
      if (durationLen !== 8 && durationLen !== 4) return null
      const view = new DataView(b.buffer, b.byteOffset + durationAt, durationLen)
      const current = durationLen === 8 ? view.getFloat64(0) : view.getFloat32(0)
      if (current > 0) return null
      const out = b.slice()
      const outView = new DataView(out.buffer, durationAt, durationLen)
      if (durationLen === 8) outView.setFloat64(0, value); else outView.setFloat32(0, value)
      return out
    }

    const element = new Uint8Array(11)
    element[0] = 0x44; element[1] = 0x89; element[2] = 0x88
    new DataView(element.buffer).setFloat64(3, value)

    let newSize: Uint8Array | null = null
    for (let len = size.len; len <= 8 && !newSize; len++) newSize = sizeBytes(size.size + element.length, len)
    if (!newSize) return null

    const sizeAt = at + el.len
    const out = new Uint8Array(b.length - size.len + newSize.length + element.length)
    out.set(b.subarray(0, sizeAt), 0)
    out.set(newSize, sizeAt)
    out.set(b.subarray(dataAt, end), sizeAt + newSize.length)
    out.set(element, sizeAt + newSize.length + size.size)
    out.set(b.subarray(end), sizeAt + newSize.length + size.size + element.length)

    return shiftCues(out, out.length - b.length) ? out : null
  }
  return null
}

/** The recording with its length written in — or the recording as it was. */
export async function withDuration(blob: Blob, ms: number): Promise<Blob> {
  try {
    const fixed = withDurationBytes(new Uint8Array(await blob.arrayBuffer()), ms)
    return fixed ? new Blob([fixed], { type: blob.type }) : blob
  } catch {
    return blob
  }
}
