import { describe, expect, it } from 'vitest'
import { withDuration, withDurationBytes } from './webm'

/* A WebM laid out the way Chrome's recorder writes one, small enough to read. */

const bytes = (...parts: Array<number[] | Uint8Array>) => {
  const out: number[] = []
  for (const p of parts) out.push(...p)
  return Uint8Array.from(out)
}
const uint = (n: number, len: number) => {
  const out: number[] = []
  for (let i = len - 1; i >= 0; i--) out.push(Math.floor(n / 256 ** i) % 256)
  return out
}
/** An element with a one-byte size (or two, for bigger ones). */
const el = (id: number[], data: number[] | Uint8Array) =>
  data.length < 127
    ? bytes(id, [0x80 | data.length], data)
    : bytes(id, [0x40 | (data.length >> 8), data.length & 0xff], data)
const float64 = (v: number) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return b }
const float32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v); return b }

const HEADER = el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], [...'webm'].map(c => c.charCodeAt(0))))
const SEGMENT_UNKNOWN = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
const scale = (ns: number) => el([0x2a, 0xd7, 0xb1], uint(ns, 3))
const app = (name = 'Chrome') => el([0x4d, 0x80], [...name].map(c => c.charCodeAt(0)))
const TRACKS = el([0x16, 0x54, 0xae, 0x6b], el([0xae], [0xd7, 0x81, 0x01]))
const CLUSTER = bytes([0x1f, 0x43, 0xb6, 0x75, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], el([0xe7], [0x00]), el([0xa3], [0x81, 0x00, 0x00, 0x80, 1, 2, 3]))

const webm = (...infoChildren: Uint8Array[]) =>
  bytes(HEADER, SEGMENT_UNKNOWN, el([0x15, 0x49, 0xa9, 0x66], bytes(...infoChildren)), TRACKS, CLUSTER)

/** Reads the Duration back out, the way a player would find it. */
function durationOf(b: Uint8Array): number | null {
  const find = (sig: number[], from = 0) => {
    outer: for (let i = from; i <= b.length - sig.length; i++) {
      for (let j = 0; j < sig.length; j++) if (b[i + j] !== sig[j]) continue outer
      return i
    }
    return -1
  }
  const info = find([0x15, 0x49, 0xa9, 0x66])
  const sizeLen = b[info + 4] & 0x80 ? 1 : 2
  const size = sizeLen === 1 ? b[info + 4] & 0x7f : ((b[info + 4] & 0x3f) << 8) | b[info + 5]
  const start = info + 4 + sizeLen
  const d = find([0x44, 0x89], start)
  if (d < 0 || d >= start + size) return null
  const len = b[d + 2] & 0x7f
  const view = new DataView(b.buffer, b.byteOffset + d + 3, len)
  return len === 8 ? view.getFloat64(0) : view.getFloat32(0)
}

describe('writing the length into a recording', () => {
  it('adds the length Chrome leaves out, in milliseconds at the usual scale', () => {
    const file = webm(scale(1_000_000), app())
    expect(durationOf(file)).toBeNull()
    const fixed = withDurationBytes(file, 6_250)!
    expect(fixed).not.toBeNull()
    expect(durationOf(fixed)).toBe(6_250)
    expect(fixed.length).toBe(file.length + 11)
  })

  it('keeps everything after the Info byte for byte', () => {
    const file = webm(scale(1_000_000), app())
    const fixed = withDurationBytes(file, 4_000)!
    const tail = bytes(TRACKS, CLUSTER)
    expect(Array.from(fixed.slice(fixed.length - tail.length))).toEqual(Array.from(tail))
  })

  it('counts in the file’s own timecode scale', () => {
    const fixed = withDurationBytes(webm(scale(500_000), app()), 3_000)!
    expect(durationOf(fixed)).toBe(6_000)
  })

  it('fills in an empty length where one is already written, without moving anything', () => {
    for (const empty of [float64(0), float32(0)]) {
      const file = webm(scale(1_000_000), el([0x44, 0x89], empty), app())
      const fixed = withDurationBytes(file, 2_500)!
      expect(fixed.length).toBe(file.length)
      expect(durationOf(fixed)).toBe(2_500)
    }
  })

  it('leaves a file that already knows its length alone', () => {
    expect(withDurationBytes(webm(scale(1_000_000), el([0x44, 0x89], float64(9_000))), 2_500)).toBeNull()
  })

  it('writes a longer size when the Info outgrows one byte', () => {
    const file = webm(scale(1_000_000), app('x'.repeat(110)))
    const fixed = withDurationBytes(file, 12_000)!
    expect(fixed).not.toBeNull()
    expect(durationOf(fixed)).toBe(12_000)
    expect(fixed.length).toBe(file.length + 11 + 1)
  })

  it('leaves alone what it cannot safely change', () => {
    // An MP4, as Safari records.
    expect(withDurationBytes(bytes([0, 0, 0, 0x18], [...'ftypmp42'].map(c => c.charCodeAt(0))), 1_000)).toBeNull()
    // An index of byte positions before the Info.
    const seekHead = el([0x11, 0x4d, 0x9b, 0x74], el([0x4d, 0xbb], [0x53, 0xab, 0x80]))
    expect(withDurationBytes(bytes(HEADER, SEGMENT_UNKNOWN, seekHead, el([0x15, 0x49, 0xa9, 0x66], scale(1_000_000)), CLUSTER), 1_000)).toBeNull()
    // A Segment whose size is written down, which would have to grow too.
    expect(withDurationBytes(bytes(HEADER, el([0x18, 0x53, 0x80, 0x67], el([0x15, 0x49, 0xa9, 0x66], scale(1_000_000)))), 1_000)).toBeNull()
    // Something that looks like the start of Cues in the picture data, but is not a whole Cues at the end.
    expect(withDurationBytes(bytes(webm(scale(1_000_000)), [0x1c, 0x53, 0xbb, 0x6b, 0x85, 1, 2, 3, 4, 5, 6, 7]), 1_000)).toBeNull()
    // No length to write.
    expect(withDurationBytes(webm(scale(1_000_000)), 0)).toBeNull()
  })

  it('moves the Cues’ cluster positions by exactly the bytes it added', () => {
    // Where each cluster starts, counted from the Segment's data, as Chrome writes them at the end.
    const cue = (time: number, position: number[]) =>
      el([0xbb], bytes(el([0xb3], [time]), el([0xb7], bytes(el([0xf7], [0x02]), el([0xf1], position), el([0x53, 0x78], [0x04])))))
    const file = bytes(webm(scale(1_000_000), app()), el([0x1c, 0x53, 0xbb, 0x6b], bytes(cue(0, [0x85]), cue(20, [0x01, 0x47, 0xa9]))))
    const fixed = withDurationBytes(file, 4_000)!
    expect(fixed).not.toBeNull()
    const tail = Array.from(fixed.slice(fixed.length - 40))
    const at = (sig: number[]) => tail.findIndex((_, i) => sig.every((x, j) => tail[i + j] === x))
    expect(tail[at([0xf1, 0x81]) + 2]).toBe(0x85 + 11)
    const wide = at([0xf1, 0x83]) + 2
    expect(tail[wide] * 65536 + tail[wide + 1] * 256 + tail[wide + 2]).toBe(0x0147a9 + 11)
    expect(durationOf(fixed)).toBe(4_000)
  })

  it('leaves the file alone rather than write a cue position that no longer fits', () => {
    const cue = el([0xbb], bytes(el([0xb3], [0]), el([0xb7], bytes(el([0xf7], [0x02]), el([0xf1], [0xfa])))))
    expect(withDurationBytes(bytes(webm(scale(1_000_000)), el([0x1c, 0x53, 0xbb, 0x6b], cue)), 1_000)).toBeNull()
  })

  it('hands back the very same file when there is nothing to do', async () => {
    const mp4 = new Blob([bytes([0, 0, 0, 0x18], [...'ftypmp42'].map(c => c.charCodeAt(0)))], { type: 'video/mp4' })
    expect(await withDuration(mp4, 1_000)).toBe(mp4)
    const fixed = await withDuration(new Blob([webm(scale(1_000_000))], { type: 'video/webm' }), 1_000)
    expect(fixed.type).toBe('video/webm')
    expect(durationOf(new Uint8Array(await fixed.arrayBuffer()))).toBe(1_000)
  })
})
