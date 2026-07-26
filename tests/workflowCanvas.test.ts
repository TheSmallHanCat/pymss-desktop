import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clampZoom,
  connectionPath,
  marqueeRect,
  noteSelectionKey,
  parseSelectionKey,
  rectsIntersect,
  screenToWorldPoint,
  selectionKeyNodeId,
  stepSelectionKey,
  utilityInputPortIds,
  utilityInputPortToken,
  utilityOutputPortToken,
  utilitySelectionKey,
  zoomAroundPoint,
} from '../src/utils/workflowCanvas.ts'

test('selection keys round-trip through the parser', () => {
  // The editor builds these in one place and takes them apart in dozens; a mismatch would fail
  // silently, because an unparsed key simply selects nothing.
  assert.deepEqual(parseSelectionKey(stepSelectionKey('step_1')), { kind: 'step', id: 'step_1' })
  assert.deepEqual(parseSelectionKey(noteSelectionKey('note_1')), { kind: 'note', id: 'note_1' })
  assert.deepEqual(parseSelectionKey(utilitySelectionKey('tool_1')), { kind: 'utility', id: 'tool_1' })
})

test('the singleton nodes are their own keys', () => {
  assert.deepEqual(parseSelectionKey('input'), { kind: 'input', id: 'input' })
  assert.deepEqual(parseSelectionKey('save'), { kind: 'save', id: 'save' })
})

test('ids containing a colon survive parsing', () => {
  // Node ids are generated, but a workflow imported from elsewhere may carry anything.
  assert.deepEqual(parseSelectionKey('step:a:b'), { kind: 'step', id: 'a:b' })
})

test('unrecognised keys parse to null rather than a wrong node', () => {
  for (const key of ['', 'unknown', 'step:', 'note:', 'utility:', 'steps:1', ':x']) {
    assert.equal(parseSelectionKey(key), null, key)
  }
})

test('the node id helper mirrors the parser', () => {
  assert.equal(selectionKeyNodeId('step:step_1'), 'step_1')
  assert.equal(selectionKeyNodeId('input'), 'input')
  assert.equal(selectionKeyNodeId('garbage'), '')
})

test('port tokens are distinct per node and port', () => {
  assert.notEqual(utilityInputPortToken('a', 'input:0'), utilityInputPortToken('a', 'input:1'))
  assert.notEqual(utilityInputPortToken('a', 'input:0'), utilityInputPortToken('b', 'input:0'))
  assert.notEqual(utilityOutputPortToken('a'), utilityInputPortToken('a', 'input:0'))
})

test('an ensemble exposes one input port per configured input', () => {
  assert.deepEqual(utilityInputPortIds('audio_ensemble', 3), ['input:0', 'input:1', 'input:2'])
})

test('an ensemble input count is clamped to what the editor can draw', () => {
  // A corrupt or hand-edited value must not produce a node with no ports or hundreds of them.
  assert.equal(utilityInputPortIds('audio_ensemble', 0).length, 2)
  assert.equal(utilityInputPortIds('audio_ensemble', -5).length, 2)
  assert.equal(utilityInputPortIds('audio_ensemble', 999).length, 10)
  assert.equal(utilityInputPortIds('audio_ensemble', undefined).length, 2)
  assert.equal(utilityInputPortIds('audio_ensemble', 'nonsense').length, 2)
})

test('single-input utilities expose exactly one port', () => {
  assert.deepEqual(utilityInputPortIds('audio_normalize'), ['input'])
  assert.deepEqual(utilityInputPortIds('audio_invert_phase'), ['input'])
})

test('a batch input node consumes nothing', () => {
  assert.deepEqual(utilityInputPortIds('load_audio_batch'), [])
})

test('a connection path starts and ends at its ports', () => {
  const path = connectionPath({ x: 10, y: 20 }, { x: 300, y: 80 })
  assert.ok(path.startsWith('M 10 20'))
  assert.ok(path.endsWith('300 80'))
})

test('short connections still bow out', () => {
  // Without a floor on the control offset, near-vertical connections collapse into a straight
  // line and become impossible to tell apart when several overlap.
  const path = connectionPath({ x: 0, y: 0 }, { x: 4, y: 100 })
  assert.ok(path.includes('C 80 0'), path)
})

test('zoom is clamped to the allowed range', () => {
  assert.equal(clampZoom(5, 0.2, 2), 2)
  assert.equal(clampZoom(0.01, 0.2, 2), 0.2)
  assert.equal(clampZoom(1, 0.2, 2), 1)
})

test('a non-finite zoom falls back instead of blanking the canvas', () => {
  // NaN would propagate into every transform on the canvas.
  assert.equal(clampZoom(Number.NaN, 0.2, 2), 0.2)
  assert.equal(clampZoom(Number.POSITIVE_INFINITY, 0.2, 2), 2)
})

test('screen coordinates map into canvas space', () => {
  const point = screenToWorldPoint(150, 120, { left: 50, top: 20 }, { x: 0, y: 0, k: 1 })
  assert.deepEqual(point, { x: 100, y: 100 })
})

test('the viewport transform is undone when mapping to canvas space', () => {
  const point = screenToWorldPoint(150, 120, { left: 50, top: 20 }, { x: 20, y: 10, k: 2 })
  assert.deepEqual(point, { x: 40, y: 45 })
})

test('zooming keeps the point under the cursor fixed', () => {
  // The whole reason this helper exists: otherwise the canvas drifts away from what you point at.
  const rect = { left: 0, top: 0 }
  const viewport = { x: -100, y: -50, k: 1 }
  const before = screenToWorldPoint(300, 200, rect, viewport)
  const zoomed = zoomAroundPoint(300, 200, 2, rect, viewport)
  const after = screenToWorldPoint(300, 200, rect, zoomed)
  assert.ok(Math.abs(after.x - before.x) < 1e-9, `${after.x} vs ${before.x}`)
  assert.ok(Math.abs(after.y - before.y) < 1e-9, `${after.y} vs ${before.y}`)
})

test('overlapping rectangles are detected', () => {
  const a = { x: 0, y: 0, width: 100, height: 100 }
  assert.equal(rectsIntersect(a, { x: 50, y: 50, width: 100, height: 100 }), true)
  assert.equal(rectsIntersect(a, { x: 200, y: 0, width: 10, height: 10 }), false)
})

test('rectangles that only touch do not count as overlapping', () => {
  // Otherwise a marquee that stops exactly at a node's edge would select it.
  const a = { x: 0, y: 0, width: 100, height: 100 }
  assert.equal(rectsIntersect(a, { x: 100, y: 0, width: 10, height: 10 }), false)
})

test('a marquee normalises whichever way it was dragged', () => {
  const forward = marqueeRect({ x: 10, y: 10 }, { x: 60, y: 40 })
  const backward = marqueeRect({ x: 60, y: 40 }, { x: 10, y: 10 })
  assert.deepEqual(forward, { x: 10, y: 10, width: 50, height: 30 })
  assert.deepEqual(backward, forward)
})
