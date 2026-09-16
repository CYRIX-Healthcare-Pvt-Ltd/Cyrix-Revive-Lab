import { describe, it, expect } from 'vitest'
import {
  fitWithin, extensionFor, pickRecorderMime, pickVideoRecorderMime, clock, humanSize,
  PHOTO_QUALITIES, MAX_VIDEO_SECONDS, VIDEO_BITS_PER_SECOND, MAX_UPLOAD_BYTES,
} from './media'

describe('fitWithin — photos sent at most 1280px', () => {
  it('shrinks the long side to the limit and keeps the shape', () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1280, height: 960 })
    expect(fitWithin(3000, 4000)).toEqual({ width: 960, height: 1280 })
  })
  it('never enlarges a small photo', () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 })
  })
  it('says nothing about a photo with no size', () => {
    expect(fitWithin(0, 100)).toEqual({ width: 0, height: 0 })
  })
})

describe('photo qualities', () => {
  it('only ever gets rougher, and never below readable', () => {
    for (let i = 1; i < PHOTO_QUALITIES.length; i++) {
      expect(PHOTO_QUALITIES[i]).toBeLessThan(PHOTO_QUALITIES[i - 1])
    }
    expect(Math.min(...PHOTO_QUALITIES)).toBeGreaterThanOrEqual(0.4)
  })
})

describe('the video budget', () => {
  it('fits a full clip comfortably under the bucket ceiling', () => {
    const fullClip = (MAX_VIDEO_SECONDS * (VIDEO_BITS_PER_SECOND + 32_000)) / 8
    expect(fullClip).toBeLessThan(MAX_UPLOAD_BYTES / 3)
  })
})

describe('extensionFor — the names the bucket allows', () => {
  it('maps what phones and browsers produce', () => {
    expect(extensionFor('image/jpeg')).toBe('jpg')
    expect(extensionFor('video/webm;codecs=vp9,opus')).toBe('webm')
    expect(extensionFor('video/mp4')).toBe('mp4')
    expect(extensionFor('audio/webm;codecs=opus')).toBe('webm')
    expect(extensionFor('audio/mp4')).toBe('m4a')
  })
  it('gives nothing for a type the bucket would refuse', () => {
    expect(extensionFor('video/quicktime')).toBe('')
  })
})

describe('recording formats — whatever this browser can make', () => {
  it('prefers Opus in WebM for the voice note, MP4 on an iPhone', () => {
    expect(pickRecorderMime(() => true)).toBe('audio/webm;codecs=opus')
    expect(pickRecorderMime(m => m === 'audio/mp4')).toBe('audio/mp4')
  })
  it('prefers VP9 WebM for video, MP4 on an iPhone', () => {
    expect(pickVideoRecorderMime(() => true)).toBe('video/webm;codecs=vp9,opus')
    expect(pickVideoRecorderMime(m => m === 'video/mp4')).toBe('video/mp4')
  })
  it('says so when nothing can be recorded, and survives a browser that throws', () => {
    expect(pickVideoRecorderMime(() => false)).toBeNull()
    expect(pickRecorderMime(m => { if (m.includes('webm')) throw new Error('no'); return m === 'audio/ogg;codecs=opus' }))
      .toBe('audio/ogg;codecs=opus')
  })
})

describe('clock and humanSize', () => {
  it('reads like a recorder', () => {
    expect(clock(7)).toBe('0:07')
    expect(clock(30)).toBe('0:30')
  })
  it('reads like a file size', () => {
    expect(humanSize(240_000)).toBe('234 KB')
    expect(humanSize(2_100_000)).toBe('2.0 MB')
  })
})
