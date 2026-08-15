import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { setupLitegraphEnvDom } from './_litegraphEnv.mjs'

await setupLitegraphEnvDom()
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
after(() => vite.close())

const { LGraph, LiteGraph } = await vite.ssrLoadModule('@comfyorg/litegraph')
const { registerPymssNodes } = await vite.ssrLoadModule('/src/litegraph/registerNodes.ts')
const { litegraphToComfy, comfyLinksToLitegraph } = await vite.ssrLoadModule('/src/litegraph/graphAdapter.ts')
registerPymssNodes()

// Old-format graph (2-slot widgets: [audio]) -> configure -> edit input_name -> serialize
test('legacy 2-slot graph: edit input_name then save', () => {
  const comfy = {
    nodes: [
      { id: 1, type: 'pymss_load_audio', pos: [0, 0], size: [200, 80], flags: {}, order: 0, mode: 0,
        inputs: [], outputs: [{ name: 'audio', type: 'AUDIO', links: [1] }, { name: 'audio_name', type: 'STRING', links: null }],
        widgets_values: ['/Users/me/song.wav'] },
      { id: 2, type: 'pymss_save_audio', pos: [300, 0], size: [200, 80], flags: {}, order: 1, mode: 0,
        inputs: [{ name: 'audio', type: 'AUDIO', link: 1 }], outputs: [], widgets_values: ['wav', '44100'] },
    ],
    links: [[1, 1, 0, 2, 0, 'AUDIO']],
    version: 1,
  }
  const g = new LGraph()
  g.configure({
    nodes: comfy.nodes.map(n => ({ ...n, inputs: n.inputs || [], outputs: n.outputs || [] })),
    links: comfyLinksToLitegraph(comfy.links),
    version: 1,
  })
  const load = g.getNodeById(1)
  const w = load.widgets.find((x) => x.name === 'input_name')
  console.log('loaded wv:', JSON.stringify(load.widgets_values), '| widget input_name value:', JSON.stringify(w.value))
  let changed = 0
  g.onAfterChange = () => { changed++ }
  // Real UI path: canvas widget editor calls changeValue (not the setter)
  w.setValue('vocal', { e: undefined, node: load, canvas: { graph_mouse: [0, 0] } })
  console.log('onAfterChange fired:', changed > 0, '| widget value:', JSON.stringify(w.value))
  const out = litegraphToComfy(g.serialize())
  console.log('saved wv:', JSON.stringify(out.nodes[0].widgets_values))
})

// Full round-trip: save -> reload -> input_name still there?
test('round-trip: reload saved graph keeps input_name', () => {
  const saved = {
    nodes: [
      { id: 1, type: 'pymss_load_audio', pos: [0, 0], size: [200, 80], flags: {}, order: 0, mode: 0,
        inputs: [], outputs: [{ name: 'audio', type: 'AUDIO', links: [1] }, { name: 'audio_name', type: 'STRING', links: null }],
        widgets_values: ['/Users/me/song.wav', 'vocal'] },
      { id: 2, type: 'pymss_save_audio', pos: [300, 0], size: [200, 80], flags: {}, order: 1, mode: 0,
        inputs: [{ name: 'audio', type: 'AUDIO', link: 1 }], outputs: [], widgets_values: ['wav', '44100'] },
    ],
    links: [[1, 1, 0, 2, 0, 'AUDIO']],
    version: 1,
  }
  const g2 = new LGraph()
  g2.configure({
    nodes: saved.nodes.map(n => ({ ...n, inputs: n.inputs || [], outputs: n.outputs || [] })),
    links: comfyLinksToLitegraph(saved.links),
    version: 1,
  })
  const w2 = g2.getNodeById(1).widgets.find((x) => x.name === 'input_name')
  assert.equal(w2.value, 'vocal')
})

// Regression: serialize() emits object-format links; restoreSnapshot used to
// pass them through comfyLinksToLitegraph which dropped every non-array link,
// wiping all connections on undo/redo.
test('object-format links survive comfyLinksToLitegraph round-trip', () => {
  const objLinks = [
    { id: 1, origin_id: 1, origin_slot: 0, target_id: 2, target_slot: 0, type: 'AUDIO' },
  ]
  const converted = comfyLinksToLitegraph(objLinks)
  assert.equal(converted.length, 1, 'object-format link must pass through')
  assert.equal(converted[0].target_id, 2)

  const g3 = new LGraph()
  g3.configure({
    nodes: [
      { id: 1, type: 'pymss_load_audio', pos: [0, 0], size: [200, 80], flags: {}, order: 0, mode: 0,
        inputs: [], outputs: [{ name: 'audio', type: 'AUDIO', links: [1] }, { name: 'audio_name', type: 'STRING', links: null }] },
      { id: 2, type: 'pymss_save_audio', pos: [300, 0], size: [200, 80], flags: {}, order: 1, mode: 0,
        inputs: [{ name: 'audio', type: 'AUDIO', link: 1 }], outputs: [] },
    ],
    links: converted,
    version: 1,
  })
  assert.equal(g3.links.size, 1, 'configure must restore the link')
})

// Regression: real stored workflow (comfy array links) loads with all links.
test('real comfy array links configure restores 37 links', async () => {
  const { readFileSync } = await import('node:fs')
  const def = JSON.parse(readFileSync('/Volumes/data/pymss-studio/testflow.json', 'utf8'))
  const nodes = Array.isArray(def.nodes) ? def.nodes : []
  const links = Array.isArray(def.links) ? def.links : []
  assert.equal(nodes.length, 27, 'fixture node count')
  assert.equal(links.length, 37, 'fixture link count')
  assert.ok(Array.isArray(links[0]), 'fixture links are comfy array tuples')

  const g4 = new LGraph()
  g4.configure({
    nodes: nodes.map(n => ({ ...n, inputs: n.inputs || [], outputs: n.outputs || [] })),
    links: comfyLinksToLitegraph(links),
    last_node_id: def.last_node_id ?? Math.max(...nodes.map(n => Number(n.id))),
    last_link_id: def.last_link_id ?? Math.max(...links.map(l => Number(l[0]))),
    groups: [], version: 1,
  })
  assert.equal(g4.links.size, 37, 'all links restored after configure')
})

// Regression: the ACTUAL stored definition (data/settings/workflows.json),
// whose links are numeric-key objects ({0: id, 1: src, ...}) from litegraphToComfy.
test('stored workflows.json definition restores all links', async () => {
  const { readFileSync } = await import('node:fs')
  const store = JSON.parse(readFileSync('/Volumes/data/pymss-studio/data/settings/workflows.json', 'utf8'))
  const wfs = store.workflows || store
  const w = (Array.isArray(wfs) ? wfs : []).find(x => x.name === 'testflow')
  assert.ok(w, 'testflow in store')
  const def = w.definition
  const nodes = def.nodes, links = def.links
  assert.ok(!Array.isArray(links[0]) && typeof links[0] === 'object', 'fixture uses numeric-key link objects')

  const g5 = new LGraph()
  g5.configure({
    nodes: nodes.map(n => ({ ...n, inputs: n.inputs || [], outputs: n.outputs || [] })),
    links: comfyLinksToLitegraph(links),
    last_node_id: def.last_node_id ?? Math.max(...nodes.map(n => Number(n.id))),
    last_link_id: def.last_link_id ?? Math.max(...links.map(l => Number(l[0]))),
    groups: [], version: 1,
  })
  assert.equal(g5.links.size, links.length, 'all stored links restored')
})
