import { monotonicFactory } from 'ulid'

const next = monotonicFactory()

/** Create time-ordered client IDs without reusing a value in the same millisecond. */
export function createId(): string {
  return next()
}
