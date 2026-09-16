import { describe, it, expect } from 'vitest'
import { fitWithin, extensionFor, pickRecorderMime, clock, humanSize } from './media'

describe('fitWithin — photos sent at most 1600px', () => {
  it('shrinks the long side to the limit and keeps the shape', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1600, height: 1200 })
    expect(fitWithin(3000, 4000)).toEqual({ width: 1200, height: 1600 })
  })
  it('never enlarges a small photo', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 })
  })
  it('says nothing about a photo with no size', () => {
    expect(fitWithin(0, 100)).toEqual({ width: 0, height: 0 })
  })
})

describe('extensionFor — the names the bucket allows', () => {
  it('maps what phones and browsers produce', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg')
    expect(extensionFor('audio/webm;codecs=opus')).toBe('webm')
    expect(extensionFor('audio/mp4')).toBe('m4a')
    expect(extensionFor('audio/ogg; codecs=opus')).toBe('ogg')
  })
  it('gives nothing for a type the bucket would refuse', () => {
    expect(extensionFor('application/pdf')).toBe('')
  })
})

describe('pickRecorderMime — whatever this browser can record', () => {
  it('prefers Opus in WebM', () => {
    expect(pickRecorderMime(() => true)).toBe('audio/webm;codecs=opus')
  })
  it('falls to MP4 on an iPhone', () => {
    expect(pickRecorderMime(m => m === 'audio/mp4')).toBe('audio/mp4')
  })
  it('says so when nothing can be recorded', () => {
    expect(pickRecorderMime(() => false)).toBeNull()
  })
  it('survives a browser that throws when asked', () => {
    expect(pickRecorderMime(m => { if (m.includes('webm')) throw new Error('nope'); return m === 'audio/ogg;codecs=opus' }))
      .toBe('audio/ogg;codecs=opus')
  })
})

describe('clock and humanSize', () => {
  it('reads like a recorder', () => {
    expect(clock(7)).toBe('0:07')
    expect(clock(60)).toBe('1:00')
  })
  it('reads like a file size', () => {
    expect(humanSize(240_000)).toBe('234 KB')
    expect(humanSize(1_300_000)).toBe('1.2 MB')
  })
})
