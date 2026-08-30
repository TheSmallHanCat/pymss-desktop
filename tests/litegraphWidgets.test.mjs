import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'vite'
import { setupLitegraphEnvDom } from './_litegraphEnv.mjs'

await setupLitegraphEnvDom()
const vite = await createServer({
  configFile: false,
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
  ssr: { noExternal: ['@comfyorg/litegraph'] },
})
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
  let changed = 0
  g.onAfterChange = () => { changed++ }
  // Real UI path: canvas widget editor calls changeValue (not the setter)
  w.setValue('vocal', { e: undefined, node: load, canvas: { graph_mouse: [0, 0] } })
  const out = litegraphToComfy(g.serialize())
  assert.ok(changed > 0, 'editing a widget must mark the graph as changed')
  assert.deepEqual(out.nodes[0].widgets_values, ['/Users/me/song.wav', 'vocal'])
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

// Regression: stored workflows come in two link shapes — comfy array tuples
// (real comfy-mss export) and numeric-key objects (older litegraphToComfy
// output). comfyLinksToLitegraph must restore links from both.
function twoLoadGraph() {
  return [
    { id: 1, type: 'pymss_load_audio', pos: [0, 0], size: [200, 80], flags: {}, order: 0, mode: 0,
      inputs: [], widgets_values: ['/a/input.wav', 'audio1'],
      outputs: [{ name: 'audio', type: 'AUDIO', links: [1] }, { name: 'audio_name', type: 'STRING', links: null }] },
    { id: 2, type: 'pymss_load_audio', pos: [0, 120], size: [200, 80], flags: {}, order: 1, mode: 0,
      inputs: [], widgets_values: ['/a/input2.wav', 'audio2'],
      outputs: [{ name: 'audio', type: 'AUDIO', links: [2] }, { name: 'audio_name', type: 'STRING', links: null }] },
    { id: 3, type: 'pymss_save_audio', pos: [300, 0], size: [200, 80], flags: {}, order: 2, mode: 0,
      inputs: [{ name: 'audio', type: 'AUDIO', link: 1 }], widgets_values: ['wav'] },
    { id: 4, type: 'pymss_save_audio', pos: [300, 120], size: [200, 80], flags: {}, order: 3, mode: 0,
      inputs: [{ name: 'audio', type: 'AUDIO', link: 2 }], widgets_values: ['wav'] },
  ]
}

test('comfy array-tuple links restore all links', () => {
  const nodes = twoLoadGraph()
  const links = [
    [1, 1, 0, 3, 0, 'AUDIO'],
    [2, 2, 0, 4, 0, 'AUDIO'],
  ]
  const g4 = new LGraph()
  g4.configure({
    nodes: nodes.map(n => ({ ...n, inputs: n.inputs || [], outputs: n.outputs || [] })),
    links: comfyLinksToLitegraph(links),
    last_node_id: 4, last_link_id: 2, groups: [], version: 1,
  })
  assert.equal(g4.links.size, 2, 'all links restored after configure')
})

test('numeric-key object links (old litegraphToComfy output) restore all links', () => {
  const nodes = twoLoadGraph()
  const links = [
    { 0: 1, 1: 1, 2: 0, 3: 3, 4: 0, 5: 'AUDIO' },
    { 0: 2, 1: 2, 2: 0, 3: 4, 4: 0, 5: 'AUDIO' },
  ]
  const g5 = new LGraph()
  g5.configure({
    nodes: nodes.map(n => ({ ...n, inputs: n.inputs || [], outputs: n.outputs || [] })),
    links: comfyLinksToLitegraph(links),
    last_node_id: 4, last_link_id: 2, groups: [], version: 1,
  })
  assert.equal(g5.links.size, 2, 'all stored links restored')
})
