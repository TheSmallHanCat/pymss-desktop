import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
  resolve: {
    alias: { '@': fileURLToPath(new URL('../src', import.meta.url)) },
  },
})
after(() => vite.close())

const {
  detectWorkflowFormat,
  isGraphWorkflowDefinition,
  isSimpleWorkflowDefinition,
  normalizeGraphWorkflowDefinition,
  normalizeSimpleWorkflowDefinition,
} = await vite.ssrLoadModule('/src/workflows/formats.ts')
const { convertSimpleWorkflowToGraph } = await vite.ssrLoadModule('/src/workflows/simpleToGraph.ts')
const {
  countWorkflowSaveOutputs,
  getWorkflowDefinitionIssue,
  mergeSimpleInferenceParams,
  prepareWorkflowDefinitionForRun,
  resolveWorkflowRuntimeDefaults,
} = await vite.ssrLoadModule('/src/workflows/runtimeDefinition.ts')
const {
  applyGraphDefaultWidgets,
  storeGraphDefaults,
} = await vite.ssrLoadModule('/src/workflows/graphDefaults.ts')
const {
  analyzeSimpleWorkflow,
  resolveWorkflowOpenMode,
} = await vite.ssrLoadModule('/src/utils/workflowSimple.ts')
const { analyzeWorkflowInputs } = await vite.ssrLoadModule('/src/utils/workflowInputs.ts')

function simpleFixture() {
  return {
    version: 1,
    defaults: {
      device: 'cuda',
      output_format: 'flac',
      inference_params: { normalize: true },
    },
    steps: [
      {
        id: 'vocals',
        model: 'first.ckpt',
        input: 'input',
        stems: ['vocals', 'instrumental'],
        save: { vocals: 'vocals' },
      },
      {
        id: 'cleanup',
        model: 'second.pth',
        input: 'vocals.vocals',
        stems: ['clean', 'noise'],
        save: { clean: 'clean' },
      },
    ],
  }
}

test('workflow format detection rejects ambiguous definitions', () => {
  assert.equal(detectWorkflowFormat({ steps: [] }), 'simple')
  assert.equal(detectWorkflowFormat({ nodes: [], links: [] }), 'graph')
  assert.equal(detectWorkflowFormat({ nodes: [] }), 'graph')
  assert.equal(detectWorkflowFormat({ nodes: [], links: null }), 'graph')
  assert.equal(detectWorkflowFormat({ nodes: [], links: 'invalid' }), 'unknown')
  assert.equal(detectWorkflowFormat({ nodes: [], links: [], steps: [] }), 'unknown')
  assert.equal(detectWorkflowFormat({}), 'unknown')
  assert.equal(isSimpleWorkflowDefinition({ steps: [] }), true)
  assert.equal(isGraphWorkflowDefinition({ nodes: [], links: [] }), true)
})

test('legacy custom separator widgets migrate without mutating stored input', () => {
  const legacy = {
    nodes: [{
      id: 1,
      type: 'custom_mss_separate',
      widgets_values: ['custom.ckpt', 'mel_band_roformer', 'cuda', false, 'modelscope', '0,1', true],
    }],
    links: [],
  }
  const normalized = normalizeGraphWorkflowDefinition(legacy)

  assert.notEqual(normalized, legacy)
  assert.deepEqual(legacy.nodes[0].widgets_values, [
    'custom.ckpt', 'mel_band_roformer', 'cuda', false, 'modelscope', '0,1', true,
  ])
  assert.deepEqual(normalized.nodes[0].widgets_values, [
    'custom.ckpt', 'mel_band_roformer', 'cuda', '0,1', true,
  ])
  assert.equal(normalizeGraphWorkflowDefinition(normalized), normalized)

  const withoutTrailingDebug = {
    nodes: [{
      type: 'custom_mss_separate',
      widgets_values: ['custom.ckpt', 'mel_band_roformer', 'cpu', true, 'huggingface', '0'],
    }],
  }
  assert.deepEqual(
    normalizeGraphWorkflowDefinition(withoutTrailingDebug).nodes[0].widgets_values,
    ['custom.ckpt', 'mel_band_roformer', 'cpu', '0', false],
  )

  const currentWithTrailingValue = {
    nodes: [{
      type: 'custom_mss_separate',
      widgets_values: ['custom.ckpt', 'mel_band_roformer', 'cuda', '0,1', true, null],
    }],
  }
  assert.equal(normalizeGraphWorkflowDefinition(currentWithTrailingValue), currentWithTrailingValue)
})

test('legacy simple save filename templates migrate to output directories', () => {
  const legacy = simpleFixture()
  legacy.steps[0].save.vocals = '%filename%_vocals_first.wav'
  legacy.steps[1].save.clean = 'mastered'
  const normalized = normalizeSimpleWorkflowDefinition(legacy)

  assert.notEqual(normalized, legacy)
  assert.equal(legacy.steps[0].save.vocals, '%filename%_vocals_first.wav')
  assert.equal(normalized.steps[0].save.vocals, 'vocals')
  assert.equal(normalized.steps[1].save.clean, 'mastered')
  assert.equal(normalizeSimpleWorkflowDefinition(normalized), normalized)
})

test('workflow validation follows the detected definition format', () => {
  assert.equal(getWorkflowDefinitionIssue(simpleFixture()), null)
  assert.equal(getWorkflowDefinitionIssue({ steps: [] }), 'steps-required')
  assert.equal(getWorkflowDefinitionIssue({ version: 1, steps: [{ id: 'empty', save: {} }] }), 'no-save-outputs')
  assert.equal(getWorkflowDefinitionIssue({ steps: [{ save: { vocals: 'vocals' } }] }), 'invalid-definition')
  assert.equal(getWorkflowDefinitionIssue({ steps: [], defaults: 'cuda' }), 'invalid-definition')
  assert.equal(getWorkflowDefinitionIssue({ steps: [{}], defaults: { inference_params: [] } }), 'invalid-definition')
  assert.equal(getWorkflowDefinitionIssue({ steps: [{ save: [] }] }), 'invalid-definition')
  assert.equal(getWorkflowDefinitionIssue({ nodes: [{ type: 'pymss_save_audio' }], links: [] }), null)
  assert.equal(getWorkflowDefinitionIssue({ nodes: [{ type: 'mss_separate' }], links: [] }), 'no-save-outputs')
  assert.equal(getWorkflowDefinitionIssue({}), 'invalid-format')
  assert.equal(countWorkflowSaveOutputs(simpleFixture()), 2)
  assert.equal(countWorkflowSaveOutputs({
    steps: [{ save: { vocals: false, other: '', backing: ['mix-a', '', 'mix-b'] } }],
  }), 1)
  assert.equal(getWorkflowDefinitionIssue({
    version: 1,
    steps: [{ save: { vocals: false } }],
  }), 'no-save-outputs')
  assert.equal(countWorkflowSaveOutputs({
    nodes: [
      { type: 'pymss_save_audio' },
      { type: 'mss_separate' },
      { type: 'SaveAudio' },
    ],
    links: [],
  }), 2)
  assert.equal(countWorkflowSaveOutputs({}), 0)
})

test('simple editor opens only definitions it can round-trip without data loss', () => {
  const editable = simpleFixture()
  assert.deepEqual(analyzeSimpleWorkflow(editable), { editable: true, reasonCodes: [] })
  assert.equal(resolveWorkflowOpenMode(editable), 'simple')

  const advancedInference = structuredClone(editable)
  advancedInference.steps[0].inference_params = { chunk_size: 4096 }
  assert.deepEqual(analyzeSimpleWorkflow(advancedInference), {
    editable: false,
    reasonCodes: ['advanced_parameters'],
  })
  assert.equal(resolveWorkflowOpenMode(advancedInference), 'advanced')

  const customModel = structuredClone(editable)
  customModel.steps[0].model_path = 'D:/Models/custom.ckpt'
  customModel.steps[0].model_type = 'bs_roformer'
  assert.equal(analyzeSimpleWorkflow(customModel).editable, false)

  const extraMetadata = structuredClone(editable)
  extraMetadata.runtime_extension = { enabled: true }
  assert.deepEqual(analyzeSimpleWorkflow(extraMetadata), {
    editable: false,
    reasonCodes: ['advanced_parameters'],
  })

  const malformed = structuredClone(editable)
  malformed.defaults = 'cuda'
  assert.deepEqual(analyzeSimpleWorkflow(malformed), {
    editable: false,
    reasonCodes: ['invalid_definition'],
  })

  const malformedStepInference = structuredClone(editable)
  malformedStepInference.steps[0].inference_params = []
  assert.deepEqual(analyzeSimpleWorkflow(malformedStepInference), {
    editable: false,
    reasonCodes: ['invalid_definition'],
  })

  const futureVersion = structuredClone(editable)
  futureVersion.version = 2
  assert.deepEqual(analyzeSimpleWorkflow(futureVersion), {
    editable: false,
    reasonCodes: ['invalid_definition'],
  })

  assert.deepEqual(analyzeSimpleWorkflow({ nodes: [], links: [] }), {
    editable: false,
    reasonCodes: ['graph_workflow'],
  })
  assert.deepEqual(analyzeSimpleWorkflow({}), {
    editable: false,
    reasonCodes: ['invalid_definition'],
  })
})

test('simple runtime preparation materializes defaults without mutating the stored workflow', () => {
  const source = simpleFixture()
  source.defaults.inference_params.batch_size = 2
  source.steps[1].device = 'cpu'
  source.steps[1].output_format = 'mp3'
  source.steps[1].inference_params = { normalize: false, chunk_size: 4096 }
  const before = structuredClone(source)
  const prepared = prepareWorkflowDefinitionForRun(source, {
    device: 'cpu',
    outputFormat: 'wav',
  })

  assert.deepEqual(source, before)
  assert.equal(prepared.steps[0].device, 'cuda')
  assert.equal(prepared.steps[0].output_format, 'flac')
  assert.deepEqual(prepared.steps[0].inference_params, { normalize: true, batch_size: 2 })
  assert.equal(prepared.steps[1].device, 'cpu')
  assert.equal(prepared.steps[1].output_format, 'mp3')
  assert.deepEqual(prepared.steps[1].inference_params, {
    normalize: false,
    batch_size: 2,
    chunk_size: 4096,
  })

  const withoutDefaults = {
    version: 1,
    steps: [{ id: 'step1', model: 'first.ckpt', stems: ['vocals'], save: { vocals: 'vocals' } }],
  }
  const withRuntimeFallbacks = prepareWorkflowDefinitionForRun(withoutDefaults, {
    device: 'cpu',
    outputFormat: 'mp3',
  })
  assert.equal(withRuntimeFallbacks.steps[0].device, 'cpu')
  assert.equal(withRuntimeFallbacks.steps[0].output_format, 'mp3')
})

test('runtime defaults resolve consistently for simple and graph workflows', () => {
  const fallback = { device: 'cpu', outputFormat: 'wav', modelDir: 'D:/Models' }
  assert.deepEqual(resolveWorkflowRuntimeDefaults(simpleFixture(), fallback), {
    device: 'cuda',
    outputFormat: 'flac',
    modelDir: 'D:/Models',
  })
  assert.deepEqual(resolveWorkflowRuntimeDefaults({
    nodes: [],
    links: [],
    extra: { appDefaults: { device: 'mps', output_format: 'MP3', model_dir: 'E:/Models' } },
  }, fallback), {
    device: 'mps',
    outputFormat: 'mp3',
    modelDir: 'E:/Models',
  })
  assert.deepEqual(resolveWorkflowRuntimeDefaults({}, fallback), fallback)
})

test('simple inference precedence is defaults, step use_tta, then step inference params', () => {
  assert.deepEqual(
    mergeSimpleInferenceParams({ batch_size: 4, enable_tta: true }, {}, false),
    { batch_size: 4, enable_tta: false },
  )
  assert.deepEqual(
    mergeSimpleInferenceParams({ enable_tta: true }, { enable_tta: true }, false),
    { enable_tta: true },
  )
})

test('graph runtime preparation preserves node formats and fills missing values', () => {
  const source = {
    nodes: [
      { type: 'pymss_save_audio', widgets_values: ['wav', 'Default'] },
      { type: 'pymss_save_audio', widgets_values: ['', 'Default'] },
    ],
    links: [],
    extra: { appDefaults: { device: 'cuda' } },
  }
  const prepared = prepareWorkflowDefinitionForRun(source, {
    device: 'cuda',
    outputFormat: 'FLAC',
  })

  assert.equal(prepared.nodes[0].widgets_values[0], 'wav')
  assert.equal(prepared.nodes[1].widgets_values[0], 'flac')
  assert.deepEqual(prepared.extra.appDefaults, { device: 'cuda' })
  assert.equal(source.nodes[0].widgets_values[0], 'wav')
})

test('graph defaults metadata and live widgets update independently', () => {
  const source = {
    nodes: [
      { type: 'mss_separate', widgets_values: ['model.ckpt', 'cpu'] },
      { type: 'custom_mss_separate_list', widgets_values: ['custom.ckpt', 'bs_roformer', 'cpu', '0,1', false] },
      { type: 'pymss_save_audio', widgets_values: ['flac', 'Default'] },
    ],
    extra: { editor: { scale: 1 } },
  }
  const metadataOnly = storeGraphDefaults(source, { device: 'cuda', outputFormat: 'mp3' })
  assert.equal(metadataOnly.nodes[0].widgets_values[1], 'cpu')
  assert.equal(metadataOnly.nodes[2].widgets_values[0], 'flac')
  assert.deepEqual(metadataOnly.extra, {
    editor: { scale: 1 },
    appDefaults: { device: 'cuda', output_format: 'mp3' },
  })

  const nodes = [
    {
      type: 'mss_separate',
      widgets: [
        { name: 'model_name', value: 'model.ckpt' },
        { name: 'device', value: 'cpu' },
      ],
    },
    {
      type: 'custom_mss_separate_list',
      widgets: [
        { name: 'model_name', value: 'custom.ckpt' },
        { name: 'model_type', value: 'bs_roformer' },
        { name: 'device', value: 'cpu' },
      ],
    },
    {
      type: 'pymss_save_audio',
      widgets: [{ name: 'output_format', value: 'flac' }],
    },
  ]
  applyGraphDefaultWidgets(nodes, { device: 'cuda', outputFormat: 'mp3' }, {
    device: true,
    outputFormat: false,
  })
  assert.equal(nodes[0].widgets[1].value, 'cuda')
  assert.equal(nodes[1].widgets[1].value, 'bs_roformer')
  assert.equal(nodes[1].widgets[2].value, 'cuda')
  assert.equal(nodes[2].widgets[0].value, 'flac')

  applyGraphDefaultWidgets(nodes, { device: 'cuda', outputFormat: 'mp3' }, {
    device: false,
    outputFormat: true,
  })
  assert.equal(nodes[0].widgets[1].value, 'cuda')
  assert.equal(nodes[2].widgets[0].value, 'mp3')
  assert.equal(source.nodes[0].widgets_values[1], 'cpu')
})

test('simple workflow promotion creates an independent connected graph', () => {
  const source = simpleFixture()
  const before = structuredClone(source)
  const graph = convertSimpleWorkflowToGraph(source, {
    sourceWorkflowId: 'workflow-1',
    models: [{ name: 'second.pth', modelType: 'vr' }],
  })

  assert.deepEqual(source, before, 'conversion must not mutate the simple workflow')
  assert.equal(detectWorkflowFormat(graph), 'graph')
  assert.equal(graph.extra.pymssStudio.sourceWorkflowId, 'workflow-1')
  assert.equal(graph.extra.appDefaults.device, 'cuda')
  assert.equal(graph.extra.appDefaults.output_format, 'flac')

  const nodes = graph.nodes
  const links = graph.links
  assert.deepEqual(nodes.map(node => node.type), [
    'input_audio',
    'pymss_mss_params',
    'mss_separate',
    'pymss_save_audio',
    'pymss_vr_params',
    'vr_separate',
    'pymss_save_audio',
  ])
  assert.deepEqual(nodes[0].widgets_values, [])
  assert.deepEqual(analyzeWorkflowInputs(graph), {
    slots: [],
    selfContained: 0,
    unresolved: [],
  })
  assert.equal(nodes[1].widgets_values[3], true, 'global normalize default is preserved')
  assert.equal(nodes[3].widgets_values[0], 'flac')

  const firstSeparate = nodes.find(node => node.type === 'mss_separate')
  const secondSeparate = nodes.find(node => node.type === 'vr_separate')
  const chained = links.find(link => link[1] === firstSeparate.id && link[3] === secondSeparate.id)
  assert.ok(chained, 'the second step must consume the selected upstream stem')
  assert.equal(chained[2], 0, 'vocals is the first interleaved audio output')
  assert.equal(chained[4], 0)
})

test('simple workflow promotion preserves global inference defaults and step overrides', () => {
  const source = simpleFixture()
  source.defaults.inference_params = {
    batch_size: 4,
    overlap_size: 1024,
    chunk_size: 4096,
    normalize: true,
    enable_tta: true,
    standardize: true,
  }
  source.steps[1].inference_params = {
    batch_size: 2,
    window_size: 768,
    aggression: 7,
  }
  source.steps[1].use_tta = false
  const graph = convertSimpleWorkflowToGraph(source, {
    models: [{ name: 'second.pth', modelType: 'vr' }],
  })
  const mssParams = graph.nodes.find(node => node.type === 'pymss_mss_params')
  const vrParams = graph.nodes.find(node => node.type === 'pymss_vr_params')

  assert.deepEqual(mssParams.widgets_values, [4, '1024', '4096', true, true, true])
  assert.deepEqual(vrParams.widgets_values, [2, 768, 7, false, false, false, 0.2, true])
})

test('simple workflow promotion preserves model directories and registered user models', () => {
  const source = simpleFixture()
  source.defaults.model_dir = 'D:/Models'
  source.steps[0] = {
    ...source.steps[0],
    model: 'Local vocals',
    model_path: 'D:/Weights/local.ckpt',
    config_path: 'D:/Weights/local.yaml',
    model_type: 'bs_roformer',
    model_dir: 'D:/Models',
  }
  const graph = convertSimpleWorkflowToGraph(source, {
    models: [{
      name: 'Local vocals',
      modelType: 'bs_roformer',
      modelPath: 'D:/Weights/local.ckpt',
      source: 'user',
    }],
  })
  const custom = graph.nodes.find(node => node.type === 'custom_mss_separate')

  assert.deepEqual(custom.widgets_values.slice(0, 3), ['Local vocals', 'bs_roformer', 'cuda'])
  assert.equal(graph.extra.appDefaults.model_dir, 'D:/Models')
})

test('simple workflow promotion rejects custom paths that the graph cannot resolve', () => {
  const source = simpleFixture()
  source.steps[0].model = ''
  source.steps[0].model_path = 'D:/Weights/unregistered.ckpt'
  source.steps[0].model_type = 'bs_roformer'

  assert.throws(
    () => convertSimpleWorkflowToGraph(source),
    /unregistered model_path/,
  )
})

test('simple workflow promotion rejects a dangling step input', () => {
  const source = simpleFixture()
  source.steps[1].input = 'missing.vocals'
  assert.throws(
    () => convertSimpleWorkflowToGraph(source),
    /Unknown input reference/,
  )
})
