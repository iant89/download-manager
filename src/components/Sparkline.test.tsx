/**
 * The throughput graphs are the only place a user can see a transfer moving,
 * so the scaling has to make activity visible rather than merely correct.
 */
import { describe, expect, it } from 'vitest'

import { sparklineGeometry } from './Sparkline'

const ys = (data: number[], height = 40) => sparklineGeometry(data, 200, height).coords.map(([, y]) => y)

describe('sparklineGeometry', () => {
  it('keeps every coordinate finite and inside the box', () => {
    for (const data of [[], [5], [0, 0], [NaN, 5, Infinity, -3, 2], [1e9, 0, 2e9]]) {
      const { coords } = sparklineGeometry(data, 200, 40)
      for (const [x, y] of coords) {
        expect(Number.isFinite(x)).toBe(true)
        expect(Number.isFinite(y)).toBe(true)
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(200)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(40)
      }
    }
  })

  it('shows the shape of a transfer that holds a steady rate', () => {
    // A constant ~5 MB/s with ±4% jitter: against a zero baseline this is a
    // flat line glued to the top edge, i.e. no visible activity.
    const data = Array.from({ length: 40 }, (_, i) => 5_000_000 * (i % 2 === 0 ? 1 : 1.04))
    const values = ys(data)
    expect(Math.max(...values) - Math.min(...values)).toBeGreaterThan(20)
  })

  it('shows a short burst inside a long idle window', () => {
    const data = [...Array(60).fill(0), 8_000_000, 7_500_000, 6_000_000, 0, 0]
    const values = ys(data, 30)
    // The idle floor and the burst peak must be far apart…
    expect(values[0]).toBeGreaterThan(25)
    expect(Math.min(...values.slice(60, 63))).toBeLessThan(8)
  })

  it('draws an idle series flat on the floor', () => {
    expect(new Set(ys(Array(30).fill(0))).size).toBe(1)
    expect(ys(Array(30).fill(0), 30)[0]).toBeCloseTo(28.5, 5)
  })
})
