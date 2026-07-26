import assert from 'node:assert/strict'
import test from 'node:test'

import { matchesModelSource } from '../src/utils/modelSource.ts'

test('the all filter keeps every model', () => {
  assert.equal(matchesModelSource({ source: 'catalog' }, 'all'), true)
  assert.equal(matchesModelSource({ source: 'user' }, 'all'), true)
  assert.equal(matchesModelSource({}, 'all'), true)
})

test('the user filter keeps only imported models', () => {
  assert.equal(matchesModelSource({ source: 'user' }, 'user'), true)
  assert.equal(matchesModelSource({ source: 'catalog' }, 'user'), false)
})

test('the catalog filter excludes imported models', () => {
  assert.equal(matchesModelSource({ source: 'catalog' }, 'catalog'), true)
  assert.equal(matchesModelSource({ source: 'user' }, 'catalog'), false)
})

test('models cached before the source field existed still count as catalog models', () => {
  // The persisted model cache predates `source`, so restored entries carry none. Testing for
  // `source === 'catalog'` would make the whole library vanish under the catalog filter until
  // the next refetch.
  assert.equal(matchesModelSource({}, 'catalog'), true)
  assert.equal(matchesModelSource({ source: undefined }, 'catalog'), true)
  assert.equal(matchesModelSource({}, 'user'), false)
})

test('an unknown source value is treated as a catalog model', () => {
  // Forward compatibility: a source this build does not know must not disappear from the
  // default catalog view, which is where users expect to find everything.
  assert.equal(matchesModelSource({ source: 'something-new' }, 'catalog'), true)
  assert.equal(matchesModelSource({ source: 'something-new' }, 'user'), false)
})

test('a missing model never matches a narrowing filter', () => {
  assert.equal(matchesModelSource(null, 'user'), false)
  assert.equal(matchesModelSource(undefined, 'all'), true)
})
