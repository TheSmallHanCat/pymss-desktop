import assert from 'node:assert/strict'
import test from 'node:test'

import { matchesModelQuery } from '../src/utils/modelSearch.ts'

const MODEL = {
  name: 'bs_roformer_voc.ckpt',
  aliases: ['voc_hyperace'],
  architecture: 'bs_roformer',
  modelType: 'bs_roformer',
  targetStem: 'vocals',
  configTargetInstrument: 'vocals',
  category: 'vocal/separation',
  categoryCn: '人声 / 分离',
  classificationBasis: 'config_instruments',
}

test('an empty query matches everything', () => {
  // Callers pass the raw input value, so a blank box must not filter anything out.
  assert.equal(matchesModelQuery(MODEL, ''), true)
  assert.equal(matchesModelQuery(MODEL, '   '), true)
})

test('the note is searchable', () => {
  // The reason this helper exists: the separation page used to search everything except the note,
  // so a model could be found in the library and not when picking one to run.
  assert.equal(matchesModelQuery(MODEL, 'best for pop', 'best for pop vocals'), true)
  assert.equal(matchesModelQuery(MODEL, 'best for pop'), false)
})

test('the note matches case-insensitively like every other field', () => {
  assert.equal(matchesModelQuery(MODEL, 'POP', 'best for pop vocals'), true)
})

test('每个字段都可搜索', () => {
  const cases: Array<[string, string]> = [
    ['name', 'roformer_voc'],
    ['alias', 'hyperace'],
    ['architecture', 'bs_roformer'],
    ['targetStem', 'vocals'],
    ['category', 'separation'],
    ['categoryCn', '人声'],
    ['classificationBasis', 'config_instruments'],
  ]
  for (const [label, query] of cases) {
    assert.equal(matchesModelQuery(MODEL, query), true, `${label} should be searchable`)
  }
})

test('a query matching nothing is rejected', () => {
  assert.equal(matchesModelQuery(MODEL, 'drums'), false)
})

test('models missing optional fields do not throw', () => {
  // Imported models carry no targetStem or classificationBasis until a config supplies them.
  assert.equal(matchesModelQuery({ name: 'custom' }, 'custom'), true)
  assert.equal(matchesModelQuery({ name: 'custom' }, 'vocals'), false)
  assert.equal(matchesModelQuery({}, 'anything'), false)
})

test('a missing model matches nothing but an empty query', () => {
  assert.equal(matchesModelQuery(null, 'x'), false)
  assert.equal(matchesModelQuery(undefined, ''), true)
})

test('a null modelType is tolerated', () => {
  assert.equal(matchesModelQuery({ name: 'a', modelType: null }, 'a'), true)
})
