import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
after(() => vite.close())

const {
  analyzeSimpleWorkflow,
  buildSimpleWorkflowDefinition,
  hydrateSimpleWorkflow,
  resolveWorkflowOpenMode,
} = await vite.ssrLoadModule('/src/utils/workflowSimple.ts')
const { createPinia } = await vite.ssrLoadModule('pinia')
const {
  useWorkflowStore,
  WorkflowRevisionConflictError,
} = await vite.ssrLoadModule('/src/stores/workflow.ts')

const defaults = {
  device: 'auto',
  output_format: 'wav',
  model_dir: null,
  inference_params: { normalize: false },
}

test('round-trips a linear separation graph through simple mode', () => {
  const definition = buildSimpleWorkflowDefinition({
    defaultDevice: 'auto',
    defaultFormat: 'flac',
    defaultNormalize: false,
    steps: [{
      id: 'step_a',
      model: 'model.ckpt',
      input: 'input',
      stems: ['vocals', 'instrument'],
      save: { vocals: 'vocals', instrument: 'instrument' },
      overlapSize: 4,
      modelKind: null,
      customModelType: null,
    }],
    utilityNodes: [],
    saveTargets: [],
    ui: {
      viewport: { x: 0, y: 0, k: 1 },
      nodes: {},
      notes: [],
      collapsedStepIds: [],
    },
  })

  assert.equal(analyzeSimpleWorkflow(definition).editable, true)
  assert.equal(resolveWorkflowOpenMode(definition), 'simple')
  const draft = hydrateSimpleWorkflow(definition)
  assert.equal(draft.defaultFormat, 'flac')
  assert.equal(draft.steps[0].model, 'model.ckpt')
  assert.deepEqual(draft.steps[0].stems, ['vocals', 'instrument'])
})

test('rejects utility workflows', () => {
  const definition = {
    version: 2,
    kind: 'pymss-studio-graph',
    defaults,
    graph: {
      viewport: { x: 0, y: 0, k: 1 },
      nodes: [
        { id: 'input', type: 'input_audio', position: { x: 0, y: 0 }, data: {} },
        { id: 'normalize', type: 'audio_normalize', position: { x: 200, y: 0 }, data: {} },
        { id: 'save', type: 'save_outputs', position: { x: 400, y: 0 }, data: { outputs: { 'utility:normalize': 'normalized' } } },
      ],
      edges: [
        { id: 'e1', source: { nodeId: 'input', portId: 'audio' }, target: { nodeId: 'normalize', portId: 'input' } },
        { id: 'e2', source: { nodeId: 'normalize', portId: 'audio' }, target: { nodeId: 'save', portId: 'save:utility:normalize' } },
      ],
    },
  }

  assert.equal(analyzeSimpleWorkflow(definition).reasonCodes.includes('utility_nodes'), true)
  assert.equal(resolveWorkflowOpenMode(definition), 'advanced')
})

test('rejects Comfy-MSS metadata', () => {
  const definition = {
    version: 2,
    kind: 'pymss-studio-graph',
    defaults,
    graph: {
      viewport: { x: 0, y: 0, k: 1 },
      nodes: [
        { id: 'input', type: 'input_audio', position: { x: 0, y: 0 }, data: {} },
        { id: 'step_a', type: 'separate', position: { x: 200, y: 0 }, data: { model: 'model.ckpt', stems: ['vocals'], comfyMeta: { classType: 'MSS' } } },
        { id: 'save', type: 'save_outputs', position: { x: 400, y: 0 }, data: { outputs: { 'step_a.vocals': 'vocals' } } },
      ],
      edges: [
        { id: 'e1', source: { nodeId: 'input', portId: 'audio' }, target: { nodeId: 'step_a', portId: 'input' } },
        { id: 'e2', source: { nodeId: 'step_a', portId: 'stem:vocals' }, target: { nodeId: 'save', portId: 'save:step_a.vocals' } },
      ],
    },
  }

  assert.equal(analyzeSimpleWorkflow(definition).reasonCodes.includes('comfy_metadata'), true)
})

test('rejects a separation node with no input edge', () => {
  const definition = buildSimpleWorkflowDefinition({
    defaultDevice: 'auto',
    defaultFormat: 'wav',
    defaultNormalize: false,
    steps: [{
      id: 'step_a', model: 'model.ckpt', input: 'input', stems: ['vocals'],
      save: { vocals: 'vocals' }, overlapSize: null, modelKind: null, customModelType: null,
    }],
    utilityNodes: [], saveTargets: [],
    ui: { viewport: { x: 0, y: 0, k: 1 }, nodes: {}, notes: [], collapsedStepIds: [] },
  })
  definition.graph.edges = definition.graph.edges.filter(edge => edge.target.nodeId !== 'step_a')

  const analysis = analyzeSimpleWorkflow(definition)
  assert.equal(analysis.editable, false)
  assert.equal(analysis.reasonCodes.includes('invalid_graph'), true)
})

test('rejects duplicate save edges', () => {
  const definition = buildSimpleWorkflowDefinition({
    defaultDevice: 'auto',
    defaultFormat: 'wav',
    defaultNormalize: false,
    steps: [{
      id: 'step_a', model: 'model.ckpt', input: 'input', stems: ['vocals'],
      save: { vocals: 'vocals' }, overlapSize: null, modelKind: null, customModelType: null,
    }],
    utilityNodes: [], saveTargets: [],
    ui: { viewport: { x: 0, y: 0, k: 1 }, nodes: {}, notes: [], collapsedStepIds: [] },
  })
  const saveEdge = definition.graph.edges.find(edge => edge.target.nodeId === 'save')
  definition.graph.edges.push({ ...saveEdge, id: 'duplicate-save' })

  const analysis = analyzeSimpleWorkflow(definition)
  assert.equal(analysis.editable, false)
  assert.equal(analysis.reasonCodes.includes('custom_save_behavior'), true)
})

test('round-trips representable fan-out without changing inputs', () => {
  const definition = buildSimpleWorkflowDefinition({
    defaultDevice: 'auto',
    defaultFormat: 'wav',
    defaultNormalize: false,
    steps: [
      {
        id: 'step_a', model: 'model-a.ckpt', input: 'input', stems: ['vocals'],
        save: { vocals: 'vocals' }, overlapSize: null, modelKind: null, customModelType: null,
      },
      {
        id: 'step_b', model: 'model-b.ckpt', input: 'input', stems: ['instrument'],
        save: { instrument: 'instrument' }, overlapSize: null, modelKind: null, customModelType: null,
      },
    ],
    utilityNodes: [], saveTargets: [],
    ui: { viewport: { x: 0, y: 0, k: 1 }, nodes: {}, notes: [], collapsedStepIds: [] },
  })

  assert.equal(analyzeSimpleWorkflow(definition).editable, true)
  const hydrated = hydrateSimpleWorkflow(definition)
  assert.deepEqual(hydrated.steps.map(step => step.input), ['input', 'input'])
  const rebuilt = buildSimpleWorkflowDefinition(hydrated)
  const inputTargets = rebuilt.graph.edges
    .filter(edge => edge.source.nodeId === 'input')
    .map(edge => edge.target.nodeId)
    .sort()
  assert.deepEqual(inputTargets, ['step_a', 'step_b'])
})

test('preserves workflow defaults not managed by simple mode', () => {
  const source = buildSimpleWorkflowDefinition({
    defaultDevice: 'cpu',
    defaultFormat: 'wav',
    defaultNormalize: false,
    steps: [{
      id: 'step_a', model: 'model.ckpt', input: 'input', stems: ['vocals'],
      save: { vocals: 'vocals' }, overlapSize: null, modelKind: null, customModelType: null,
    }],
    utilityNodes: [], saveTargets: [],
    ui: { viewport: { x: 0, y: 0, k: 1 }, nodes: {}, notes: [], collapsedStepIds: [] },
  })
  source.defaults.model_dir = '/models/custom'
  source.defaults.inference_params = {
    ...source.defaults.inference_params,
    batch_size: 8,
    chunk_size: 352800,
    standardize: true,
  }

  const draft = hydrateSimpleWorkflow(source)
  draft.defaultDevice = 'mps'
  draft.defaultFormat = 'flac'
  draft.defaultNormalize = true
  const rebuilt = buildSimpleWorkflowDefinition(draft, source)

  assert.equal(rebuilt.defaults.device, 'mps')
  assert.equal(rebuilt.defaults.output_format, 'flac')
  assert.equal(rebuilt.defaults.model_dir, '/models/custom')
  assert.deepEqual(rebuilt.defaults.inference_params, {
    batch_size: 8,
    chunk_size: 352800,
    standardize: true,
    normalize: true,
  })
})

test('treats saving a deleted workflow as a revision conflict', async () => {
  const store = useWorkflowStore(createPinia())
  await assert.rejects(
    store.saveWorkflow({
      id: 'deleted-workflow',
      name: 'Deleted workflow',
      definition: {},
      expectedUpdatedAt: 123,
    }),
    error => error instanceof WorkflowRevisionConflictError,
  )
})
