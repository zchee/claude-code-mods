import { describe, expect, test } from 'claude-code/testing'

import { armOf, isCompactionDue, settle } from '../hooks/trigger'

/**
 * One turn's end: the usage read, whether a compaction is expected to be
 * requested, and, when one is, the usage read after it (`null` for a
 * request that failed, so nothing was read; `undefined` for usage that is
 * not known yet).
 */
type Step = { percent: number | undefined; due: boolean; after?: number | null }

describe('isCompactionDue', () => {
  const runs: Record<string, { threshold: number; steps: Step[] }> = {
    'success: usage under the threshold never asks': {
      threshold: 60,
      steps: [
        { percent: 0, due: false },
        { percent: 59, due: false },
      ],
    },
    'success: usage at the threshold asks': {
      threshold: 60,
      steps: [{ percent: 60, due: true, after: 20 }],
    },
    'success: unknown usage never asks': {
      threshold: 60,
      steps: [{ percent: undefined, due: false }],
    },
    'success: after a compaction that left 70 the next waits for 80': {
      threshold: 60,
      steps: [
        { percent: 75, due: true, after: 70 },
        { percent: 75, due: false },
        { percent: 79, due: false },
        { percent: 80, due: true, after: 78 },
        { percent: 87, due: false },
        { percent: 88, due: true, after: 30 },
      ],
    },
    'success: a drop under the threshold forgets the floor': {
      threshold: 60,
      steps: [
        { percent: 75, due: true, after: 70 },
        { percent: 50, due: false },
        { percent: 61, due: true, after: 20 },
      ],
    },
    'success: a compaction that got under the threshold leaves no floor': {
      threshold: 60,
      steps: [
        { percent: 75, due: true, after: 55 },
        { percent: 61, due: true, after: 58 },
        { percent: 60, due: true, after: 20 },
      ],
    },
    'success: a compaction that left exactly the threshold leaves a floor': {
      threshold: 60,
      steps: [
        { percent: 75, due: true, after: 60 },
        { percent: 69, due: false },
        { percent: 70, due: true, after: 20 },
      ],
    },
    'success: a threshold of 95 is asked for again after a compaction that left 92':
      {
        threshold: 95,
        steps: [
          { percent: 95, due: true, after: 92 },
          { percent: 96, due: true, after: 40 },
        ],
      },
    'success: with usage unknown after a compaction the next reading is the floor':
      {
        threshold: 60,
        steps: [
          { percent: 75, due: true, after: undefined },
          { percent: 72, due: false },
          { percent: 81, due: false },
          { percent: 82, due: true, after: undefined },
          { percent: 40, due: false },
          { percent: 60, due: true, after: 10 },
        ],
      },
    'success: a compaction that left usage above 90 is not asked for again until usage drops under the threshold':
      {
        // From a floor of 92 a rise of ten points is past the top of the
        // window, so no reading can re-arm the trigger until one under the
        // threshold has cleared the floor.
        threshold: 60,
        steps: [
          { percent: 95, due: true, after: 92 },
          { percent: 93, due: false },
          { percent: 97, due: false },
          { percent: 100, due: false },
          { percent: 59, due: false },
          { percent: 60, due: true, after: 30 },
        ],
      },
    'success: with usage unknown after a compaction the first reading at or above the threshold is the level to rise from':
      {
        threshold: 60,
        steps: [
          { percent: 70, due: true, after: undefined },
          { percent: 75, due: false },
          { percent: 84, due: false },
          { percent: 85, due: true, after: 40 },
        ],
      },
    'success: a request that failed is not repeated on the next turn': {
      threshold: 60,
      steps: [
        { percent: 75, due: true, after: null },
        { percent: 76, due: false },
        { percent: 84, due: false },
        { percent: 85, due: true, after: null },
      ],
    },
  }

  for (const [name, { threshold, steps }] of Object.entries(runs)) {
    test(name, () => {
      const arm = armOf()
      const asked = steps.map(step => {
        const isDue = isCompactionDue(arm, step.percent, threshold)

        if (isDue && step.after !== null) {
          settle(arm, step.after, threshold)
        }

        return isDue
      })

      expect(asked).toEqual(steps.map(step => step.due))
    })
  }

  test('success: only a reading at or above the threshold is kept as the floor', () => {
    const arm = armOf()

    settle(arm, 92, 95)
    expect(arm).toEqual({ isFloorPending: false })

    settle(arm, 95, 95)
    expect(arm).toEqual({ floor: 95, isFloorPending: false })

    settle(arm, undefined, 95)
    expect(arm).toEqual({ isFloorPending: true })
  })
})
