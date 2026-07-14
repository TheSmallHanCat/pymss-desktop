import assert from 'node:assert/strict'
import test from 'node:test'

import { sortStemOutputsByOrder } from '../src/utils/stemOrder.ts'

test('sorts outputs by configured stem order', () => {
  const outputs = [
    { stem: 'instrument', path: '/outputs/instrument.flac' },
    { stem: 'vocals', path: '/outputs/vocals.flac' },
  ]

  assert.deepEqual(
    sortStemOutputsByOrder(outputs, ['vocals', 'instrument']),
    [outputs[1], outputs[0]],
  )
})
