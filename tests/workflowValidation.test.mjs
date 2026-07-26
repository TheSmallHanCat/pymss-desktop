import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after } from 'node:test'

import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
after(() => vite.close())

const {
  getWorkflowValidationRuleCode,
  getWorkflowValidationSummary,
  workflowValidationErrorMessage,
} = await vite.ssrLoadModule('/src/utils/workflowDefinition.ts')

const corpus = JSON.parse(readFileSync(new URL('./fixtures/workflow-validation.json', import.meta.url), 'utf-8'))

test('the shared corpus is not empty', () => {
  // Guards the loader: an unreadable fixture would otherwise make every case below vacuous.
  assert.ok(corpus.cases.length >= 8, 'the corpus must cover every shared rule')
})

for (const testCase of corpus.cases) {
  test(`[shared] ${testCase.name}`, () => {
    const summary = getWorkflowValidationSummary(testCase.definition)
    assert.equal(
      getWorkflowValidationRuleCode(summary),
      testCase.expect.ts,
      `summary was ${JSON.stringify(summary)}`,
    )
  })
}

test('every shared rule code appears in the corpus', () => {
  // Otherwise a rule could drift out of sync with the runtime without any test noticing.
  const covered = new Set(corpus.cases.map(item => item.expect.ts).filter(Boolean))
  const expected = [
    'dangling_connection',
    'invalid_port',
    'duplicate_input',
    'cycle',
    'no_save_outputs',
    'utility_input_missing',
  ]
  const missing = expected.filter(code => !covered.has(code))
  assert.deepEqual(missing, [], `add corpus cases for: ${missing.join(', ')}`)
})

test('an accepted workflow produces no error message', () => {
  const accepted = corpus.cases.find(item => item.expect.ts === null)
  const summary = getWorkflowValidationSummary(accepted.definition)
  assert.equal(workflowValidationErrorMessage(summary, key => key), '')
})

test('the reported rule decides the message', () => {
  // The code and the message come from one table, so they can never disagree.
  for (const testCase of corpus.cases) {
    const summary = getWorkflowValidationSummary(testCase.definition)
    const code = getWorkflowValidationRuleCode(summary)
    const message = workflowValidationErrorMessage(summary, key => key)
    assert.equal(Boolean(code), Boolean(message), `${testCase.name}: code and message must agree`)
  }
})

test('rules are reported in a fixed order', () => {
  // A workflow can break several rules at once; the user is told about the most actionable one.
  const definition = JSON.parse(JSON.stringify(corpus.cases.find(item => item.expect.ts === 'cycle').definition))
  definition.graph.edges.push({
    id: 'ghost',
    source: { nodeId: 'nowhere', portId: 'audio' },
    target: { nodeId: 'save', portId: 'save:ghost' },
  })
  const summary = getWorkflowValidationSummary(definition)
  assert.equal(summary.graphCycleDetected, true)
  assert.equal(summary.danglingConnectionCount, 1)
  // Dangling wins: it names a concrete broken connection, a cycle needs the whole graph explained.
  assert.equal(getWorkflowValidationRuleCode(summary), 'dangling_connection')
})

test('a null summary is not an error', () => {
  assert.equal(getWorkflowValidationRuleCode(null), null)
  assert.equal(workflowValidationErrorMessage(null, key => key), '')
})
