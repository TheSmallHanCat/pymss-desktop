import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { loadAppStore, saveAppStore } from '../src/utils/appStore.ts'

const values = new Map<string, string>()

beforeEach(() => {
  values.clear()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {},
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })
})

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window')
  Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('app store persistence', () => {
  it('captures a JSON snapshot when a save is queued', async () => {
    const state = { nested: { value: 1 } }
    const save = saveAppStore('app-settings', state)
    state.nested.value = 2

    await save

    assert.deepEqual(JSON.parse(values.get('pymss-studio:app-settings') || 'null'), {
      nested: { value: 1 },
    })
  })

  it('preserves call order for consecutive writes to the same store', async () => {
    await Promise.all([
      saveAppStore('model-state', { revision: 1 }),
      saveAppStore('model-state', { revision: 2 }),
    ])

    assert.deepEqual(JSON.parse(values.get('pymss-studio:model-state') || 'null'), {
      revision: 2,
    })
  })

  it('falls back to local storage for update state on an older backend', async () => {
    const invoke = async () => {
      throw 'worker error: unknown app store: update-state'
    }
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __TAURI_INTERNALS__: { invoke } },
    })
    values.set('pymss-studio:update-state', JSON.stringify({ deferredVersion: '0.0.14' }))

    assert.deepEqual(await loadAppStore('update-state'), { deferredVersion: '0.0.14' })
    await saveAppStore('update-state', { lastAcceptedVersion: '0.0.14' })
    assert.deepEqual(JSON.parse(values.get('pymss-studio:update-state') || 'null'), {
      lastAcceptedVersion: '0.0.14',
    })
  })
})
