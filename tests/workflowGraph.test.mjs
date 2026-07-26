import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
after(() => vite.close())

const {
  createEmptyWorkflowGraphDefinition,
  getWorkflowDefinitionDefaults,
  isWorkflowGraphDefinition,
  migrateLegacyWorkflowToGraph,
  normalizeWorkflowDefinition,
  readWorkflowGraphDefinition,
  serializeWorkflowGraphDefinition,
  sortWorkflowGraphStepNodes,
} = await vite.ssrLoadModule('/src/utils/workflowGraph.ts')

const {
  buildWorkflowDefinition,
  createStepDraft,
  createWorkflowNoteDraft,
  createWorkflowUtilityNodeDraft,
  createDefaultWorkflowNodeEditorUi,
  getWorkflowValidationSummary,
  hydrateWorkflowDefinition,
  stripWorkflowUi,
} = await vite.ssrLoadModule('/src/utils/workflowDefinition.ts')

/**
 * Builds a definition through the same factories the editor uses, so fixtures carry the real
 * node shapes rather than an invented approximation of them.
 */
function buildDraftDefinition({ steps = 1, utilities = [], notes = 0 } = {}) {
  const stepDrafts = Array.from({ length: steps }, (_, index) => {
    const step = createStepDraft(index)
    step.model = `model_${index}.ckpt`
    step.stems = ['vocals', 'instrument']
    return step
  })
  // Chain each step onto the previous one's vocals output.
  stepDrafts.forEach((step, index) => {
    step.input = index === 0 ? 'input' : `${stepDrafts[index - 1].id}.vocals`
  })
  // Save whatever the last step produces. The mapping lives on the step itself — saveTargets
  // only carries the per-source output directory.
  const last = stepDrafts[stepDrafts.length - 1]
  last.save = { vocals: 'vocals' }
  return buildWorkflowDefinition({
    defaultDevice: 'auto',
    defaultFormat: 'wav',
    defaultNormalize: false,
    steps: stepDrafts,
    saveTargets: [{ source: `${last.id}.vocals`, outputDir: 'vocals' }],
    utilityNodes: utilities.map(kind => createWorkflowUtilityNodeDraft(kind, { x: 600, y: 400 })),
    ui: {
      ...createDefaultWorkflowNodeEditorUi(stepDrafts),
      notes: Array.from({ length: notes }, (_, i) => {
        const note = createWorkflowNoteDraft({ x: 100 + i * 40, y: 600 })
        note.title = `note ${i}`
        note.content = 'content'
        return note
      }),
    },
  })
}

/**
 * Compares definitions by meaning rather than by byte order.
 *
 * Key order is not a contract, and neither are edge ids: the draft round trip regenerates every
 * edge id on each pass (pinned separately below), so comparing them would only assert that
 * behaviour twice.
 */
function canonical(definition) {
  const sortKeys = (value) => {
    if (Array.isArray(value)) return value.map(sortKeys)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]))
    }
    return value
  }
  const stripped = JSON.parse(JSON.stringify(definition))
  if (stripped?.graph?.edges) {
    stripped.graph.edges = stripped.graph.edges.map(({ id, ...edge }) => edge)
  }
  return JSON.stringify(sortKeys(stripped))
}

// --------------------------------------------------------------------------------------
// Shape and normalization
// --------------------------------------------------------------------------------------

test('an empty definition always carries the input and save nodes', () => {
  // Every other part of the editor and the runtime assumes these two exist.
  const graph = createEmptyWorkflowGraphDefinition()
  const types = graph.graph.nodes.map(node => node.type).sort()
  assert.deepEqual(types, ['input_audio', 'save_outputs'])
  assert.equal(graph.kind, 'pymss-studio-graph')
  assert.equal(graph.version, 2)
})

test('reading a definition restores missing core nodes', () => {
  // A hand-edited or truncated file must not produce a graph the runtime cannot execute.
  const graph = readWorkflowGraphDefinition({ kind: 'pymss-studio-graph', graph: { nodes: [], edges: [] } })
  const types = graph.graph.nodes.map(node => node.type).sort()
  assert.deepEqual(types, ['input_audio', 'save_outputs'])
})

test('garbage input yields an empty but usable definition', () => {
  for (const value of [null, undefined, 42, 'text', []]) {
    const graph = readWorkflowGraphDefinition(value)
    assert.equal(graph.kind, 'pymss-studio-graph')
    assert.ok(graph.graph.nodes.some(node => node.type === 'input_audio'))
  }
})

test('only graph definitions are recognised as such', () => {
  assert.equal(isWorkflowGraphDefinition(createEmptyWorkflowGraphDefinition()), true)
  assert.equal(isWorkflowGraphDefinition({ version: 1, steps: [] }), false)
  assert.equal(isWorkflowGraphDefinition({ kind: 'pymss-studio-graph' }), false)
})

test('defaults survive a read and fall back when absent', () => {
  const defaults = getWorkflowDefinitionDefaults({
    kind: 'pymss-studio-graph',
    defaults: { device: 'cuda', output_format: 'flac', model_dir: '  /models  ' },
    graph: { nodes: [], edges: [] },
  })
  assert.equal(defaults.device, 'cuda')
  assert.equal(defaults.output_format, 'flac')
  assert.equal(defaults.model_dir, '/models')
  const empty = getWorkflowDefinitionDefaults({})
  assert.equal(empty.device, 'auto')
  assert.equal(empty.output_format, 'wav')
  assert.equal(empty.model_dir, null)
})

test('normalizing is idempotent', () => {
  // Saving a workflow twice without editing it must not keep producing new content.
  const once = normalizeWorkflowDefinition(buildDraftDefinition({ steps: 2 }))
  const twice = normalizeWorkflowDefinition(once)
  assert.equal(canonical(once), canonical(twice))
})

// --------------------------------------------------------------------------------------
// Legacy migration
// --------------------------------------------------------------------------------------

test('a legacy step workflow migrates into an equivalent graph', () => {
  const legacy = {
    version: 1,
    defaults: { device: 'auto', output_format: 'wav', inference_params: { normalize: false } },
    steps: [
      { id: 'step_1', model: 'a.ckpt', input: 'input', stems: ['vocals', 'instrument'] },
      { id: 'step_2', model: 'b.ckpt', input: 'step_1.vocals', stems: ['vocals'] },
    ],
    save: [{ source: 'step_2.vocals', output_dir: 'vocals' }],
  }
  const graph = migrateLegacyWorkflowToGraph(legacy)
  const stepNodes = graph.graph.nodes.filter(node => node.type === 'separate')
  assert.deepEqual(stepNodes.map(node => node.id), ['step_1', 'step_2'])
  assert.deepEqual(stepNodes.map(node => node.data.model), ['a.ckpt', 'b.ckpt'])
  // The chain between the two steps has to become a real edge, not just a stale string.
  const chain = graph.graph.edges.find(edge => edge.target.nodeId === 'step_2' && edge.target.portId === 'input')
  assert.ok(chain, 'step_2 must be wired to its input')
  assert.equal(chain.source.nodeId, 'step_1')
  assert.equal(chain.source.portId, 'stem:vocals')
})

test('reading a legacy definition migrates it automatically', () => {
  // Migration happens on read, which is what lets one persisted format exist rather than two.
  const graph = readWorkflowGraphDefinition({
    version: 1,
    steps: [{ id: 'step_1', model: 'a.ckpt', input: 'input', stems: ['vocals'] }],
    save: [{ source: 'step_1.vocals', output_dir: 'vocals' }],
  })
  assert.equal(graph.kind, 'pymss-studio-graph')
  assert.ok(graph.graph.nodes.some(node => node.id === 'step_1' && node.type === 'separate'))
})

test('migrating is idempotent once the result is a graph', () => {
  const legacy = { version: 1, steps: [{ id: 'step_1', model: 'a.ckpt', input: 'input', stems: ['vocals'] }], save: [] }
  const once = normalizeWorkflowDefinition(legacy)
  assert.equal(canonical(once), canonical(normalizeWorkflowDefinition(once)))
})

// --------------------------------------------------------------------------------------
// Round-trip fidelity — the safety net for removing the draft round-trip from the editor
// --------------------------------------------------------------------------------------

test('graph -> draft -> graph preserves meaning for every node kind', () => {
  // Every edit in the node editor currently goes through this conversion. Pinning it means a
  // later refactor that operates on the graph directly can be checked against this behaviour.
  const definition = buildDraftDefinition({
    steps: 2,
    utilities: ['audio_ensemble', 'audio_normalize', 'load_audio_batch'],
    notes: 2,
  })
  const before = serializeWorkflowGraphDefinition(readWorkflowGraphDefinition(definition))
  const after = buildWorkflowDefinition(hydrateWorkflowDefinition(before))
  assert.equal(canonical(after), canonical(before))
})

test('the round trip is stable when repeated', () => {
  // mutateDraft runs once per edit, so drift would compound rather than stay bounded.
  const definition = buildDraftDefinition({ steps: 3, utilities: ['audio_ensemble'], notes: 1 })
  let current = serializeWorkflowGraphDefinition(readWorkflowGraphDefinition(definition))
  const first = canonical(buildWorkflowDefinition(hydrateWorkflowDefinition(current)))
  for (let i = 0; i < 5; i += 1) {
    current = buildWorkflowDefinition(hydrateWorkflowDefinition(current))
  }
  assert.equal(canonical(current), first)
})

test('the round trip regenerates every edge id', () => {
  // Pinned deliberately, not endorsed: because ids churn on every edit, anything holding an
  // edge id (a selection, a hover, an undo snapshot) is invalidated by unrelated edits. It also
  // makes mutateDraft's "skip if serialization is unchanged" guard unreachable. Operating on the
  // graph directly would remove the churn — this test is what will show that change.
  const definition = buildDraftDefinition({ steps: 2 })
  const before = serializeWorkflowGraphDefinition(readWorkflowGraphDefinition(definition))
  const after = buildWorkflowDefinition(hydrateWorkflowDefinition(before))
  const idsBefore = before.graph.edges.map(edge => edge.id)
  const idsAfter = after.graph.edges.map(edge => edge.id)
  assert.equal(idsBefore.length, idsAfter.length)
  assert.ok(idsBefore.length > 0, 'the fixture must have edges for this to mean anything')
  assert.ok(
    idsBefore.every(id => !idsAfter.includes(id)),
    'current behaviour: no edge keeps its id across the round trip',
  )
})

test('every draggable element is a graph node', () => {
  // The node editor writes drag positions straight into the graph, once per animation frame per
  // selected node. That fast path only holds while every draggable thing is a graph node — if a
  // new element ever lived only in the draft, dragging it would fall back to converting the whole
  // workflow to a draft and back on every frame.
  const definition = buildDraftDefinition({ steps: 2, utilities: ['audio_ensemble'], notes: 1 })
  const graph = readWorkflowGraphDefinition(definition)
  const graphIds = new Set(graph.graph.nodes.map(node => node.id))
  const draft = hydrateWorkflowDefinition(definition)
  const draggable = [
    ...Object.keys(draft.ui.nodes),
    ...draft.ui.notes.map(note => note.id),
    ...draft.utilityNodes.map(node => node.id),
  ]
  assert.ok(draggable.length > 0)
  const missing = draggable.filter(id => !graphIds.has(id))
  assert.deepEqual(missing, [], `these are draggable but absent from the graph: ${missing.join(', ')}`)
})

test('per-node settings survive the round trip', () => {
  const definition = buildDraftDefinition({ steps: 1 })
  const draft = hydrateWorkflowDefinition(definition)
  draft.steps[0].overlapSize = 4
  draft.steps[0].modelKind = 'vr'
  draft.steps[0].customModelType = 'bs_roformer'
  const rebuilt = hydrateWorkflowDefinition(buildWorkflowDefinition(draft))
  assert.equal(rebuilt.steps[0].overlapSize, 4)
  assert.equal(rebuilt.steps[0].modelKind, 'vr')
  assert.equal(rebuilt.steps[0].customModelType, 'bs_roformer')
})

test('notes and their styling survive the round trip', () => {
  const definition = buildDraftDefinition({ steps: 1, notes: 1 })
  const draft = hydrateWorkflowDefinition(definition)
  assert.equal(draft.ui.notes.length, 1)
  draft.ui.notes[0].title = '标题'
  draft.ui.notes[0].content = '正文'
  draft.ui.notes[0].fontSize = 18
  const rebuilt = hydrateWorkflowDefinition(buildWorkflowDefinition(draft))
  assert.equal(rebuilt.ui.notes[0].title, '标题')
  assert.equal(rebuilt.ui.notes[0].content, '正文')
  assert.equal(rebuilt.ui.notes[0].fontSize, 18)
})

test('utility node settings survive the round trip', () => {
  const definition = buildDraftDefinition({ steps: 1, utilities: ['audio_ensemble'] })
  const draft = hydrateWorkflowDefinition(definition)
  const ensemble = draft.utilityNodes.find(node => node.kind === 'audio_ensemble')
  assert.ok(ensemble)
  ensemble.data.ensembleType = 'max_wave'
  ensemble.data.weights = [2, 3]
  const rebuilt = hydrateWorkflowDefinition(buildWorkflowDefinition(draft))
  const restored = rebuilt.utilityNodes.find(node => node.kind === 'audio_ensemble')
  assert.equal(restored.data.ensembleType, 'max_wave')
  assert.deepEqual(restored.data.weights, [2, 3])
})

test('node positions survive the round trip', () => {
  // Positions are what a drag writes, so losing them would corrupt the canvas on every move.
  const definition = buildDraftDefinition({ steps: 2 })
  const draft = hydrateWorkflowDefinition(definition)
  const stepId = draft.steps[0].id
  draft.ui.nodes[stepId] = { x: 1234, y: 567 }
  const rebuilt = hydrateWorkflowDefinition(buildWorkflowDefinition(draft))
  assert.deepEqual(rebuilt.ui.nodes[stepId], { x: 1234, y: 567 })
})

// --------------------------------------------------------------------------------------
// Ordering and stripping
// --------------------------------------------------------------------------------------

test('step nodes sort into execution order', () => {
  const definition = buildDraftDefinition({ steps: 3 })
  const graph = readWorkflowGraphDefinition(definition)
  const sorted = sortWorkflowGraphStepNodes(graph)
  const ids = sorted.map(node => node.id)
  const chained = graph.graph.edges.filter(edge => edge.target.portId === 'input')
  // Every chained step must appear after the step feeding it.
  chained.forEach((edge) => {
    const from = ids.indexOf(edge.source.nodeId)
    const to = ids.indexOf(edge.target.nodeId)
    if (from >= 0 && to >= 0) assert.ok(from < to, `${edge.source.nodeId} must precede ${edge.target.nodeId}`)
  })
})

test('stripping ui leaves the runtime definition intact', () => {
  const definition = buildDraftDefinition({ steps: 2, notes: 1 })
  const stripped = stripWorkflowUi(definition)
  assert.ok(!('ui' in stripped), 'ui must not reach the runtime payload')
  assert.equal(stripped.kind, definition.kind)
})

// --------------------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------------------

test('a complete workflow reports no issues', () => {
  const summary = getWorkflowValidationSummary(buildDraftDefinition({ steps: 2 }))
  assert.equal(summary.danglingConnectionCount, 0)
  assert.equal(summary.invalidConnectionCount, 0)
  assert.equal(summary.duplicateInputConnectionCount, 0)
  assert.equal(summary.noSaveOutputs, false)
})

test('a workflow with nothing wired to save is reported', () => {
  const graph = readWorkflowGraphDefinition(buildDraftDefinition({ steps: 1 }))
  graph.graph.edges = graph.graph.edges.filter(edge => edge.target.nodeId !== 'save')
  const summary = getWorkflowValidationSummary(serializeWorkflowGraphDefinition(graph))
  assert.equal(summary.noSaveOutputs, true)
})

test('a dangling connection is reported', () => {
  const graph = readWorkflowGraphDefinition(buildDraftDefinition({ steps: 1 }))
  graph.graph.edges.push({
    id: 'dangling',
    source: { nodeId: 'ghost', portId: 'output' },
    target: { nodeId: 'save', portId: 'save:x' },
  })
  const summary = getWorkflowValidationSummary(serializeWorkflowGraphDefinition(graph))
  assert.equal(summary.danglingConnectionCount, 1)
})

test('two connections into one input port are reported', () => {
  const definition = buildDraftDefinition({ steps: 2 })
  const graph = readWorkflowGraphDefinition(definition)
  const stepNodes = graph.graph.nodes.filter(node => node.type === 'separate')
  const second = stepNodes[1]
  graph.graph.edges.push({
    id: 'extra',
    source: { nodeId: 'input', portId: 'audio' },
    target: { nodeId: second.id, portId: 'input' },
  })
  const summary = getWorkflowValidationSummary(serializeWorkflowGraphDefinition(graph))
  assert.equal(summary.duplicateInputConnectionCount, 1)
})

test('a cycle in the graph is reported', () => {
  // The runtime refuses to execute a cyclic graph, so the editor has to be able to say so first.
  const graph = readWorkflowGraphDefinition(buildDraftDefinition({ steps: 2 }))
  const stepNodes = graph.graph.nodes.filter(node => node.type === 'separate')
  graph.graph.edges.push({
    id: 'back_edge',
    source: { nodeId: stepNodes[1].id, portId: 'stem:vocals' },
    target: { nodeId: stepNodes[0].id, portId: 'input' },
  })
  const summary = getWorkflowValidationSummary(serializeWorkflowGraphDefinition(graph))
  assert.equal(summary.graphCycleDetected, true)
})

test('an acyclic graph is not reported as cyclic', () => {
  assert.equal(getWorkflowValidationSummary(buildDraftDefinition({ steps: 3 })).graphCycleDetected, false)
})

test('a batch input node without a folder is reported', () => {
  const summary = getWorkflowValidationSummary(
    buildDraftDefinition({ steps: 1, utilities: ['load_audio_batch'] }),
  )
  assert.equal(summary.batchInputCount, 1)
  assert.equal(summary.batchInputMissingFolderCount, 1)
})

test('more than one batch input node is unsupported', () => {
  const summary = getWorkflowValidationSummary(
    buildDraftDefinition({ steps: 1, utilities: ['load_audio_batch', 'load_audio_batch'] }),
  )
  assert.equal(summary.batchInputMultipleUnsupported, true)
})

test('a utility node with unconnected inputs is reported', () => {
  const summary = getWorkflowValidationSummary(
    buildDraftDefinition({ steps: 1, utilities: ['audio_ensemble'] }),
  )
  // A freshly added ensemble has two empty inputs.
  assert.equal(summary.utilityInputMissingCount, 2)
})
