import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { registerWindowCloseGuard, runWindowCloseGuards } from '../src/utils/windowCloseGuards.ts'

describe('window close guards', () => {
  it('waits for registered asynchronous cleanup before closing', async () => {
    const calls: string[] = []
    const unregisterFirst = registerWindowCloseGuard(async () => {
      await Promise.resolve()
      calls.push('first')
    })
    const unregisterSecond = registerWindowCloseGuard(() => {
      calls.push('second')
    })

    try {
      await runWindowCloseGuards()
      assert.deepEqual(calls, ['first', 'second'])
    } finally {
      unregisterFirst()
      unregisterSecond()
    }
  })

  it('does not run a guard after it is unregistered', async () => {
    let called = false
    const unregister = registerWindowCloseGuard(() => {
      called = true
    })
    unregister()

    await runWindowCloseGuards()
    assert.equal(called, false)
  })

  it('runs resource finalizers before lower-priority persistence guards', async () => {
    const calls: string[] = []
    const unregisterSave = registerWindowCloseGuard(() => {
      calls.push('save')
    }, -100)
    const unregisterRecording = registerWindowCloseGuard(async () => {
      await Promise.resolve()
      calls.push('recording')
    }, 100)

    try {
      await runWindowCloseGuards()
      assert.deepEqual(calls, ['recording', 'save'])
    } finally {
      unregisterSave()
      unregisterRecording()
    }
  })
})
