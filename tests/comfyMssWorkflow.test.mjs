import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test, { after } from 'node:test'

import { createServer } from 'vite'

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
after(() => vite.close())

const {
  exportComfyMssWorkflow,
  importComfyMssWorkflow,
} = await vite.ssrLoadModule('/src/utils/comfyMssWorkflow.ts')

const {
  buildWorkflowDefinition,
  createDefaultWorkflowNodeEditorUi,
  createStepDraft,
  createWorkflowNoteDraft,
  createWorkflowUtilityNodeDraft,
  hydrateWorkflowDefinition,
} = await vite.ssrLoadModule('/src/utils/workflowDefinition.ts')

const MODELS = [
  {
    name: 'bs_roformer_voc.ckpt',
    aliases: ['voc_hyperace'],
    modelPath: '/models/bs_roformer_voc.ckpt',
    configPath: '/models/bs_roformer_voc.yaml',
    modelType: 'bs_roformer',
    architecture: 'bs_roformer',
    configInstruments: 'vocals|instrument',
    targetStem: 'vocals',
  },
]

/** A workflow built through the editor's own factories, so the shapes are the real ones. */
function makeDefinition({ steps = 1, utilities = [], notes = 0 } = {}) {
  const stepDrafts = Array.from({ length: steps }, (_, index) => {
    const step = createStepDraft(index)
    step.model = 'bs_roformer_voc.ckpt'
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
        note.content = 'body'
        return note
      }),
    },
  })
}

/** The parts of a workflow that must survive a trip through the ComfyUI format. */
function semanticShape(definition) {
  const draft = hydrateWorkflowDefinition(definition)
  return {
    steps: draft.steps.map(step => ({ model: step.model, stems: [...step.stems].sort() })),
    utilities: draft.utilityNodes.map(node => node.kind).sort(),
    saveSources: (draft.saveTargets || []).map(item => item.source.split('.').pop()).sort(),
  }
}

// --------------------------------------------------------------------------------------
// Import: rejection and warnings
// --------------------------------------------------------------------------------------

test('json that is not an object is rejected', () => {
  for (const value of [null, [], 'text', 42]) {
    assert.throws(() => importComfyMssWorkflow(value), /必须是对象/, JSON.stringify(value))
  }
})

test('an object carrying no ComfyUI nodes is rejected', () => {
  for (const value of [{}, { nodes: [] }, { nodes: 'not-an-array' }]) {
    assert.throws(() => importComfyMssWorkflow(value), /节点/, JSON.stringify(value))
  }
})

test('a ComfyUI workflow with no separation nodes is rejected', () => {
  // Importing it would silently produce an empty workflow, which reads as a successful import.
  assert.throws(
    () => importComfyMssWorkflow({ nodes: [{ id: 1, type: 'PreviewImage' }] }),
    /comfy-mss/,
  )
})

test('nodes missing an id or type are ignored rather than crashing', () => {
  const workflow = {
    nodes: [
      { type: 'mss_separate', widgets_values: ['m.ckpt', 'auto'] },
      { id: 'not-a-number', type: 'mss_separate' },
      { id: 2, type: 'mss_separate', widgets_values: ['m.ckpt', 'auto'], outputs: [{ name: 'Vocals', type: 'AUDIO' }] },
    ],
  }
  const result = importComfyMssWorkflow(workflow)
  assert.equal(hydrateWorkflowDefinition(result.definition).steps.length, 1)
})

test('a list separation node warns that its semantics are flattened', () => {
  const result = importComfyMssWorkflow({
    nodes: [{ id: 1, type: 'mss_separate_list', widgets_values: ['m.ckpt', 'auto'], outputs: [{ name: 'Vocals', type: 'AUDIO' }] }],
  })
  assert.ok(result.warnings.some(text => text.includes('List')), result.warnings.join(' | '))
})

test('several input nodes warn that only the main chain is imported', () => {
  const result = importComfyMssWorkflow({
    nodes: [
      { id: 1, type: 'pymss_load_audio' },
      { id: 2, type: 'pymss_load_audio' },
      { id: 3, type: 'mss_separate', widgets_values: ['m.ckpt', 'auto'], outputs: [{ name: 'Vocals', type: 'AUDIO' }] },
    ],
  })
  assert.ok(result.warnings.length > 0)
})

test('a batch input node is imported and announced', () => {
  const result = importComfyMssWorkflow({
    nodes: [
      { id: 1, type: 'pymss_load_audio_batch', widgets_values: ['/audio', false, true] },
      { id: 2, type: 'mss_separate', widgets_values: ['m.ckpt', 'auto'], outputs: [{ name: 'Vocals', type: 'AUDIO' }] },
    ],
  })
  const draft = hydrateWorkflowDefinition(result.definition)
  assert.ok(draft.utilityNodes.some(node => node.kind === 'load_audio_batch'))
  assert.ok(result.warnings.length > 0)
})

// --------------------------------------------------------------------------------------
// Import: content
// --------------------------------------------------------------------------------------

test('each separation node kind is recognised', () => {
  for (const type of ['mss_separate', 'vr_separate', 'custom_mss_separate']) {
    const result = importComfyMssWorkflow({
      nodes: [{ id: 1, type, widgets_values: ['m.ckpt', 'auto', 'auto'], outputs: [{ name: 'Vocals', type: 'AUDIO' }] }],
    })
    assert.equal(hydrateWorkflowDefinition(result.definition).steps.length, 1, type)
  }
})

test('stems come from the node outputs', () => {
  const result = importComfyMssWorkflow({
    nodes: [{
      id: 1,
      type: 'mss_separate',
      widgets_values: ['m.ckpt', 'auto'],
      outputs: [{ name: 'Vocals', type: 'AUDIO' }, { name: 'Instrumental', type: 'AUDIO' }],
    }],
  })
  const step = hydrateWorkflowDefinition(result.definition).steps[0]
  assert.equal(step.stems.length, 2)
})

test('node positions are carried over', () => {
  // Otherwise every imported workflow collapses onto the default layout and has to be
  // rearranged by hand.
  const result = importComfyMssWorkflow({
    nodes: [{
      id: 1,
      type: 'mss_separate',
      pos: [1234, 567],
      widgets_values: ['m.ckpt', 'auto'],
      outputs: [{ name: 'Vocals', type: 'AUDIO' }],
    }],
  })
  const draft = hydrateWorkflowDefinition(result.definition)
  const position = draft.ui.nodes[draft.steps[0].id]
  assert.deepEqual(position, { x: 1234, y: 567 })
})

test('a known model is matched by name', () => {
  const result = importComfyMssWorkflow({
    nodes: [{ id: 1, type: 'mss_separate', widgets_values: ['bs_roformer_voc.ckpt', 'auto'], outputs: [] }],
  }, { models: MODELS })
  const step = hydrateWorkflowDefinition(result.definition).steps[0]
  assert.equal(step.model, 'bs_roformer_voc.ckpt')
  // With no outputs declared, the stems have to come from the matched catalog entry.
  assert.ok(step.stems.length > 0, 'stems should be inferred from the model')
})

test('an unknown model still imports', () => {
  // A workflow referencing a model the user has not downloaded must still open, so they can see
  // what it needs.
  const result = importComfyMssWorkflow({
    nodes: [{ id: 1, type: 'mss_separate', widgets_values: ['never_seen.ckpt', 'auto'], outputs: [{ name: 'Vocals', type: 'AUDIO' }] }],
  }, { models: MODELS })
  assert.equal(hydrateWorkflowDefinition(result.definition).steps[0].model, 'never_seen.ckpt')
})

// --------------------------------------------------------------------------------------
// Export
// --------------------------------------------------------------------------------------

test('export produces a ComfyUI shaped workflow', () => {
  const comfy = exportComfyMssWorkflow(makeDefinition({ steps: 2 }), { models: MODELS })
  assert.ok(Array.isArray(comfy.nodes) && comfy.nodes.length > 0)
  assert.ok(Array.isArray(comfy.links))
  for (const node of comfy.nodes) {
    assert.equal(typeof node.id, 'number')
    assert.equal(typeof node.type, 'string')
  }
})

test('exported node ids are unique', () => {
  // ComfyUI resolves links by node id; a duplicate would silently rewire the graph.
  const comfy = exportComfyMssWorkflow(makeDefinition({ steps: 3, utilities: ['audio_ensemble'] }), { models: MODELS })
  const ids = comfy.nodes.map(node => node.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('every link refers to nodes that exist', () => {
  const comfy = exportComfyMssWorkflow(makeDefinition({ steps: 3 }), { models: MODELS })
  const ids = new Set(comfy.nodes.map(node => node.id))
  for (const link of comfy.links) {
    // [linkId, sourceNodeId, sourceSlot, targetNodeId, targetSlot, type]
    assert.ok(ids.has(link[1]), `link source ${link[1]} is missing`)
    assert.ok(ids.has(link[3]), `link target ${link[3]} is missing`)
  }
})

test('link ids are unique', () => {
  const comfy = exportComfyMssWorkflow(makeDefinition({ steps: 3 }), { models: MODELS })
  const linkIds = comfy.links.map(link => link[0])
  assert.equal(new Set(linkIds).size, linkIds.length)
})

// --------------------------------------------------------------------------------------
// Round trip — the property that makes the two directions worth having
// --------------------------------------------------------------------------------------

test('a linear workflow survives export and re-import', () => {
  const definition = makeDefinition({ steps: 2 })
  const reimported = importComfyMssWorkflow(exportComfyMssWorkflow(definition, { models: MODELS }), { models: MODELS })
  assert.deepEqual(semanticShape(reimported.definition), semanticShape(definition))
})

test('a single step workflow survives export and re-import', () => {
  const definition = makeDefinition({ steps: 1 })
  const reimported = importComfyMssWorkflow(exportComfyMssWorkflow(definition, { models: MODELS }), { models: MODELS })
  assert.deepEqual(semanticShape(reimported.definition), semanticShape(definition))
})

test('the round trip is stable when repeated', () => {
  // Drift would compound: a workflow exchanged back and forth would slowly change.
  const definition = makeDefinition({ steps: 2 })
  const once = importComfyMssWorkflow(exportComfyMssWorkflow(definition, { models: MODELS }), { models: MODELS }).definition
  const twice = importComfyMssWorkflow(exportComfyMssWorkflow(once, { models: MODELS }), { models: MODELS }).definition
  assert.deepEqual(semanticShape(twice), semanticShape(once))
})

test('exporting without a model catalog still round-trips', () => {
  // The models list is an optional hint; losing it must not lose the workflow.
  const definition = makeDefinition({ steps: 2 })
  const reimported = importComfyMssWorkflow(exportComfyMssWorkflow(definition))
  assert.deepEqual(
    semanticShape(reimported.definition).steps.map(step => step.model),
    semanticShape(definition).steps.map(step => step.model),
  )
})

test('exporting an empty workflow does not throw', () => {
  // The workflows page offers export on whatever is open, including a blank draft.
  const empty = buildWorkflowDefinition({
    defaultDevice: 'auto',
    defaultFormat: 'wav',
    defaultNormalize: false,
    steps: [],
    saveTargets: [],
    utilityNodes: [],
    ui: createDefaultWorkflowNodeEditorUi([]),
  })
  assert.doesNotThrow(() => exportComfyMssWorkflow(empty))
})

// --------------------------------------------------------------------------------------
// Real workflows saved by ComfyUI
//
// Fixtures written from reading our own importer would only prove it agrees with itself. These
// are comfy-mss's own examples, so they carry the node schema, widget order and output naming
// ComfyUI actually produces.
// --------------------------------------------------------------------------------------

const EXAMPLES_DIR = new URL('./fixtures/comfy-mss/', import.meta.url)

function readExample(name) {
  return JSON.parse(readFileSync(new URL(name, EXAMPLES_DIR), 'utf-8'))
}

const EXAMPLE_FILES = readdirSync(EXAMPLES_DIR).filter(name => name.endsWith('.json'))

test('the vendored examples are present', () => {
  assert.ok(EXAMPLE_FILES.length >= 6, `only found ${EXAMPLE_FILES.length} examples`)
})

for (const name of EXAMPLE_FILES) {
  // example_ensemble.json has no separation node at all; it is covered by its own test below.
  if (name === 'example_ensemble.json') continue
  test(`[real] ${name} imports`, () => {
    const result = importComfyMssWorkflow(readExample(name))
    const draft = hydrateWorkflowDefinition(result.definition)
    assert.ok(draft.steps.length > 0, 'a separation workflow must yield at least one step')
    for (const step of draft.steps) {
      assert.equal(typeof step.model, 'string')
      // Whatever a stem is called, it is never blank — a blank one cannot be saved or matched.
      assert.ok(step.stems.every(stem => stem.trim()), `${name}: blank stem in ${step.id}`)
    }
  })
}

test('a list separation node does not invent a stem from its list output', () => {
  // *_separate_list returns one bundled AUDIO output named "audios". Reading it as a stem
  // registered a stem no model produces, and the run failed looking for it.
  const result = importComfyMssWorkflow(readExample('exampel_list_separate_nodes.json'))
  const draft = hydrateWorkflowDefinition(result.definition)
  const stems = draft.steps.flatMap(step => step.stems)
  assert.ok(!stems.includes('audios'), `"audios" is a list container, not a stem: ${JSON.stringify(stems)}`)
  assert.ok(!stems.includes('stem_names'), 'the string output is not a stem either')
})

test('real stem names survive with their original casing', () => {
  // comfy-mss takes these from the model catalog, so VR models yield "Vocals" while MSS models
  // yield "vocals". Normalising either way would stop the stem matching its model.
  const vr = hydrateWorkflowDefinition(importComfyMssWorkflow(readExample('example_vr_separate.json')).definition)
  assert.deepEqual(vr.steps[0].stems, ['Vocals', 'Instrumental'])
  const mss = hydrateWorkflowDefinition(importComfyMssWorkflow(readExample('example_mss_separate.json')).definition)
  assert.deepEqual(mss.steps[0].stems, ['other', 'vocals'])
})

test('a batch input example imports its folder node', () => {
  const result = importComfyMssWorkflow(readExample('example_batch_separate.json'))
  const draft = hydrateWorkflowDefinition(result.definition)
  assert.ok(draft.utilityNodes.some(node => node.kind === 'load_audio_batch'))
})

test('a custom separation node with no resolved model imports without stems', () => {
  // ComfyUI only fills in a custom node's outputs once its model is known, so an exported
  // workflow can legitimately carry none. Importing it must still succeed — the user can pick
  // the model afterwards — but it must not invent stems either.
  const result = importComfyMssWorkflow(readExample('example_custom_mss_separate.json'))
  const draft = hydrateWorkflowDefinition(result.definition)
  assert.equal(draft.steps.length, 1)
  assert.deepEqual(draft.steps[0].stems, [])
})

test('a workflow with only utility nodes is currently rejected', () => {
  // Pinned, not endorsed: example_ensemble.json is a valid comfy-mss workflow (load → ensemble →
  // save) that this importer refuses because it requires a separation node. The desktop graph
  // model and runtime can both express it, so this is a real gap rather than a limitation.
  assert.throws(() => importComfyMssWorkflow(readExample('example_ensemble.json')), /分离节点/)
})
