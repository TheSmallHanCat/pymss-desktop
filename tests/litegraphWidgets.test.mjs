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
