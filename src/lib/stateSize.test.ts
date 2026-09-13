// Standalone assert-based check (no framework). Run: npx tsx src/lib/stateSize.test.ts
// A league over the blob cap used to come back as "Invalid request." (422), which
// the client retried three times and then showed verbatim. Guards the contract:
// the size failure names itself, carries limitType so the client stops retrying,
// and every other parse failure still gets the generic answer.
import assert from 'node:assert'
import { z } from 'zod'
import { stateField, parseFailure, STATE_TOO_LARGE, MAX_STATE_CHARS } from './stateSize'

const schema = z.object({ code: z.string().length(6), state: stateField })

const tooBig = schema.safeParse({ code: 'ABC123', state: { pad: 'x'.repeat(MAX_STATE_CHARS) } })
assert.strictEqual(tooBig.success, false)
const big = parseFailure(tooBig.error!)
assert.strictEqual(big.status, 413)
assert.strictEqual(big.body.error, STATE_TOO_LARGE)
assert.strictEqual(big.body.limitType, 'size')

const badCode = schema.safeParse({ code: 'nope', state: {} })
assert.strictEqual(badCode.success, false)
assert.deepStrictEqual(parseFailure(badCode.error!), { status: 422, body: { error: 'Invalid request.' } })

assert.strictEqual(schema.safeParse({ code: 'ABC123', state: { pad: 'x'.repeat(1000) } }).success, true)

console.log('stateSize.test.ts: ok')
