import { describe, it, expect } from 'vitest'
import { clockTime, gapLabel, gapWords } from './when'

describe('times read as AM or PM (the user, 23 Sep)', () => {
  it('never writes a 24-hour clock', () => {
    expect(clockTime(new Date(2026, 8, 21, 14, 2))).toBe('2:02 PM')
    expect(clockTime(new Date(2026, 8, 21, 9, 5))).toBe('9:05 AM')
    expect(clockTime(new Date(2026, 8, 21, 0, 30))).toBe('12:30 AM')
    expect(clockTime(new Date(2026, 8, 21, 12, 0))).toBe('12:00 PM')
  })
})

describe('the time between two steps', () => {
  const M = 60_000, H = 60 * M, D = 24 * H
  it('is short enough to sit on the line', () => {
    expect(gapLabel(20_000)).toBe('<1m')
    expect(gapLabel(9 * M)).toBe('9m')
    expect(gapLabel(2 * H + 5 * M)).toBe('2h 5m')
    expect(gapLabel(3 * H)).toBe('3h')
    expect(gapLabel(3 * D + 4 * H + 12 * M)).toBe('3d 4h')
  })
  it('is said in full for a screen reader', () => {
    expect(gapWords(20_000)).toBe('under a minute')
    expect(gapWords(2 * H + 5 * M)).toBe('2 hours 5 minutes')
    expect(gapWords(D + H)).toBe('1 day 1 hour')
  })
})
