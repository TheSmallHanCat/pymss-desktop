import assert from 'node:assert/strict'
import test from 'node:test'

import { calculateEditorPanelCapacity } from '../src/utils/editorLayout.ts'

const baseMetrics = {
  shellWidth: 980,
  minCenterWidth: 520,
  assetRailWidth: 34,
  inspectorRailWidth: 34,
  resizerWidth: 10,
  assetPanelWidth: 218,
  inspectorPanelWidth: 268,
  assetPanelVisible: true,
  inspectorRailVisible: true,
  inspectorPanelVisible: false,
}

test('a collapsed inspector does not reserve its full panel width', () => {
  const capacity = calculateEditorPanelCapacity(baseMetrics)
  assert.equal(capacity.centerWidth, 684)
  assert.equal(capacity.availableAssetWidth, 382)
})

test('inspector capacity accounts for the visible asset panel', () => {
  const capacity = calculateEditorPanelCapacity(baseMetrics)
  assert.equal(capacity.availableInspectorWidth, 154)
})

test('collapsing the asset panel makes room for the inspector without shrinking the timeline', () => {
  const capacity = calculateEditorPanelCapacity({
    ...baseMetrics,
    assetPanelVisible: false,
    inspectorPanelVisible: true,
  })
  assert.equal(capacity.centerWidth, 634)
  assert.equal(capacity.availableInspectorWidth, 382)
})
