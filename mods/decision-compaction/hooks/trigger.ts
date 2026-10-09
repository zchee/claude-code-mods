/**
 * What the `turn.complete` trigger remembers between turns.
 */
type Arm = {
  /**
   * The usage the last requested compaction left, while that is still at or
   * above the threshold: the level the next request has to rise from.
   */
  floor?: number
  /**
   * True from a requested compaction until usage is next known. Usage is
   * absent right after a compaction (it comes with the next response), so
   * the floor is then taken from the first reading that follows.
   */
  isFloorPending: boolean
}

/**
 * How far usage has to rise above the floor before another compaction is
 * requested, in points of the context window.
 */
const REARM_POINTS = 10

/**
 * A trigger that has requested nothing yet.
 *
 * @returns the initial state
 */
export function armOf(): Arm {
  return { isFloorPending: false }
}

/**
 * Says whether a compaction should be requested at this reading of usage,
 * and updates what is remembered.
 *
 * A reading at or above the threshold asks for one, unless an earlier
 * request left usage near where it is now: a compaction that could not get
 * usage under the threshold would otherwise be requested again at the end
 * of every turn. The next request then waits until usage has risen
 * `REARM_POINTS` above that floor. A reading under the threshold forgets
 * the floor. When the answer is yes the floor is set to the reading at
 * once, so a request that then fails is not repeated on the next turn.
 *
 * @param arm what is remembered, changed in place
 * @param percent the context usage in percent, absent when it is not known
 * @param threshold the `compactAtPercent` option
 * @returns true when a compaction should be requested now
 */
export function isCompactionDue(
  arm: Arm,
  percent: number | undefined,
  threshold: number,
): boolean {
  if (percent === undefined) {
    return false
  }

  if (percent < threshold) {
    delete arm.floor
    arm.isFloorPending = false

    return false
  }

  if (arm.isFloorPending) {
    arm.floor = percent
    arm.isFloorPending = false
  }

  if (arm.floor !== undefined && percent < arm.floor + REARM_POINTS) {
    return false
  }

  arm.floor = percent

  return true
}

/**
 * Records what a requested compaction left behind.
 *
 * A reading at or above the threshold becomes the floor: the compaction
 * could not get usage under it, so the next request has to wait for a rise.
 * A reading under the threshold leaves no floor, because the compaction
 * worked and the next crossing of the threshold is a new one; a floor kept
 * there would hold the next request back until usage was `REARM_POINTS`
 * above a level that was never a problem, which a high threshold can put
 * past the top of the window. Usage that is not known yet marks the floor as
 * pending.
 *
 * @param arm what is remembered, changed in place
 * @param percent the context usage read after the compaction
 * @param threshold the `compactAtPercent` option
 */
export function settle(
  arm: Arm,
  percent: number | undefined,
  threshold: number,
): void {
  delete arm.floor
  arm.isFloorPending = percent === undefined

  if (percent !== undefined && percent >= threshold) {
    arm.floor = percent
  }
}
