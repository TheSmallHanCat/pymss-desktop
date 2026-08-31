import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
})
after(() => vite.close())

const {
  createWorkflowHistory,
  recordWorkflowSnapshot,
  redoWorkflowHistory,
  resolveWorkflowHistoryShortcut,
  undoWorkflowHistory,
} = await vite.ssrLoadModule('/src/litegraph/history.ts')

test('the first graph edit can undo to the loaded baseline', () => {
  const baseline = JSON.stringify({ nodes: [{ id: 1 }] })
  const edited = JSON.stringify({ nodes: [{ id: 1 }, { id: 2 }] })
  const history = recordWorkflowSnapshot(createWorkflowHistory(baseline), edited)

  assert.equal(history.past.length, 1)
  assert.equal(history.past[0], baseline)
  const undo = undoWorkflowHistory(history)
  assert.equal(undo.snapshot, baseline)
  assert.equal(undo.history.current, baseline)
})

test('undo and redo preserve ordering, while a new edit clears redo history', () => {
  let history = createWorkflowHistory('A')
  history = recordWorkflowSnapshot(history, 'B')
  history = recordWorkflowSnapshot(history, 'C')

  const undoC = undoWorkflowHistory(history)
  assert.equal(undoC.snapshot, 'B')
  const undoB = undoWorkflowHistory(undoC.history)
  assert.equal(undoB.snapshot, 'A')

  const redoB = redoWorkflowHistory(undoB.history)
  assert.equal(redoB.snapshot, 'B')
  const edited = recordWorkflowSnapshot(redoB.history, 'D')
  assert.deepEqual(edited.future, [])
  assert.equal(redoWorkflowHistory(edited).snapshot, null)
})

test('history keeps only the configured number of snapshots', () => {
  let history = createWorkflowHistory('0')
  for (let i = 1; i <= 5; i += 1) {
    history = recordWorkflowSnapshot(history, String(i), 3)
  }
  assert.deepEqual(history.past, ['2', '3', '4'])

  const undo = undoWorkflowHistory(history, 3)
  const redo = redoWorkflowHistory(undo.history, 3)
  assert.equal(redo.snapshot, '5')
  assert.ok(redo.history.past.length <= 3)
})

test('history shortcuts support Windows, macOS and shifted uppercase keys', () => {
  assert.equal(resolveWorkflowHistoryShortcut({ ctrlKey: true, metaKey: false, shiftKey: false, key: 'z' }), 'undo')
  assert.equal(resolveWorkflowHistoryShortcut({ ctrlKey: true, metaKey: false, shiftKey: true, key: 'Z' }), 'redo')
  assert.equal(resolveWorkflowHistoryShortcut({ ctrlKey: true, metaKey: false, shiftKey: false, key: 'y' }), 'redo')
  assert.equal(resolveWorkflowHistoryShortcut({ ctrlKey: false, metaKey: true, shiftKey: true, key: 'Z' }), 'redo')
  assert.equal(resolveWorkflowHistoryShortcut({ ctrlKey: false, metaKey: false, shiftKey: false, key: 'z' }), null)
})
