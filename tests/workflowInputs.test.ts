import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeWorkflowInputs } from '../src/utils/workflowInputs.ts'

test('named load nodes expose runtime file slots', () => {
  const result = analyzeWorkflowInputs({
    nodes: [
      { id: 1, type: 'pymss_load_audio', widgets_values: ['input.wav', 'lead'] },
      { id: 2, type: 'pymss_load_audio', widgets_values: ['input.wav', 'lead'] },
    ],
  })
  assert.deepEqual(result.slots, [{ name: 'lead', nodeType: 'pymss_load_audio', nodeId: 1 }])
  assert.equal(result.selfContained, 0)
  assert.deepEqual(result.unresolved, [])
})

test('legacy load widgets become explicit runtime slot keys', () => {
  const result = analyzeWorkflowInputs({
    nodes: [{ id: 1, type: 'LoadAudio', widgets_values: ['input.wav'] }],
  })
  assert.deepEqual(result.slots, [{ name: 'input.wav', nodeType: 'LoadAudio', nodeId: 1 }])
  assert.deepEqual(result.unresolved, [])
})

test('batch folders and embedded file paths are self-contained inputs', () => {
  const result = analyzeWorkflowInputs({
    nodes: [
      { id: 1, type: 'pymss_load_audio_batch', widgets_values: ['D:/Audio', true, true, ''] },
      { id: 2, type: 'pymss_load_audio', widgets_values: ['D:/Audio/song.wav', ''] },
    ],
  })
  assert.equal(result.selfContained, 2)
  assert.deepEqual(result.slots, [])
  assert.deepEqual(result.unresolved, [])
})

test('empty load nodes remain unresolved instead of falling back silently', () => {
  const result = analyzeWorkflowInputs({
    nodes: [
      { id: 1, type: 'pymss_load_audio_batch', widgets_values: ['', false, true, ''] },
      { id: 2, type: 'pymss_load_audio', widgets_values: ['', ''] },
    ],
  })
  assert.deepEqual(result.unresolved.map(item => item.nodeId), [1, 2])
  assert.equal(result.selfContained, 0)
})
