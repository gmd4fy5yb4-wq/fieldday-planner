import { z } from 'zod'

// The 1.0 league is one JSON blob, and both write routes refuse one this big.
// Measured 2026-09-13: the largest live league is 46 KB (202 items, ~230 bytes
// each), so this is ~2,200 games and practices. ponytail: raise the number if a
// real league ever gets there; 2.0's per-row writes retire the cap entirely.
export const MAX_STATE_CHARS = 500_000

export const STATE_TOO_LARGE =
  'This league is too large to save. Remove some games or practices and try again.'

export const stateField = z
  .unknown()
  .refine(v => JSON.stringify(v).length < MAX_STATE_CHARS, STATE_TOO_LARGE)

/**
 * What a failed parse should answer. The size refusal is the one failure a
 * user can act on, so it gets its own words and `limitType`, which also stops
 * the client's bounded retry — resending the same blob cannot succeed.
 */
export function parseFailure(error: z.ZodError): { status: number; body: { error: string; limitType?: string } } {
  return error.issues.some(i => i.message === STATE_TOO_LARGE)
    ? { status: 413, body: { error: STATE_TOO_LARGE, limitType: 'size' } }
    : { status: 422, body: { error: 'Invalid request.' } }
}
