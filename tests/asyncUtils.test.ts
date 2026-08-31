import assert from 'node:assert/strict'
import test from 'node:test'

import { createFreshRunner, retryWithDelays } from '../src/utils/async.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('sequential calls run once each', async () => {
  let runs = 0
  const runner = createFreshRunner(async () => ++runs)
  assert.equal(await runner(), 1)
  assert.equal(await runner(), 2)
  assert.equal(runs, 2)
})

test('a call made mid-flight gets a fresh result, not the in-flight one', async () => {
  // This is the whole point: a refresh triggered by a delete must not report the sizes
  // measured before that delete happened.
  const gates = [deferred<string>(), deferred<string>()]
  let index = 0
  const runner = createFreshRunner(() => gates[index++].promise)

  const first = runner()
  const second = runner()

  gates[0].resolve('stale')
  await Promise.resolve()
  gates[1].resolve('fresh')

  assert.equal(await first, 'stale')
  assert.equal(await second, 'fresh')
  assert.equal(index, 2)
})

test('runs never overlap', async () => {
  let active = 0
  let maxActive = 0
  const runner = createFreshRunner(async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await new Promise((resolve) => setTimeout(resolve, 1))
    active -= 1
    return maxActive
  })
  await Promise.all([runner(), runner(), runner()])
  assert.equal(maxActive, 1)
})

test('a rejected run does not wedge the runner', async () => {
  let runs = 0
  const runner = createFreshRunner(async () => {
    runs += 1
    if (runs === 1) throw new Error('boom')
    return runs
  })
  await assert.rejects(runner(), /boom/)
  assert.equal(await runner(), 2)
})

test('callers queued behind a rejected run still get a fresh value', async () => {
  let runs = 0
  const runner = createFreshRunner(async () => {
    runs += 1
    if (runs === 1) throw new Error('boom')
    return runs
  })
  const failing = runner()
  const queued = runner()
  await assert.rejects(failing, /boom/)
  assert.equal(await queued, 2)
})

test('retryWithDelays recovers from a transient registration failure', async () => {
  let attempts = 0
  const waits: number[] = []
  const result = await retryWithDelays(
    async () => {
      attempts += 1
      if (attempts === 1) throw new Error('transient')
      return 'connected'
    },
    [250, 750],
    async delay => { waits.push(delay) },
  )

  assert.equal(result, 'connected')
  assert.equal(attempts, 2)
  assert.deepEqual(waits, [250])
})

test('retryWithDelays reports the final error after bounded attempts', async () => {
  let attempts = 0
  await assert.rejects(
    retryWithDelays(
      async () => {
        attempts += 1
        throw new Error(`failure-${attempts}`)
      },
      [10, 20],
      async () => undefined,
    ),
    /failure-3/,
  )
  assert.equal(attempts, 3)
})
