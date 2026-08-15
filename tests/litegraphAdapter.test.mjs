import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import test, { after } from 'node:test'

import { createServer } from 'vite'

import { setupLitegraphEnvDom } from './_litegraphEnv.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Python interpreter used for pymss round-trip checks. Resolution order:
// PYMSS_STUDIO_TEST_PYTHON env var > project venv (.venv/bin/python) > python3.
// The pymss dev environment can be set up with: uv venv .venv && uv pip install -e ../pymss
const PY = process.env.PYMSS_STUDIO_TEST_PYTHON
  || (existsSync(resolve(__dirname, '../.venv/bin/python'))
    ? resolve(__dirname, '../.venv/bin/python')
    : 'python3')

// Set up DOM globals first so vite's SSR-loaded litegraph (and registerNodes)
// share the same module instance the test uses.
await setupLitegraphEnvDom()

const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom' })
after(() => vite.close())

const { LGraph, LGraphCanvas, LiteGraph } = await vite.ssrLoadModule('@comfyorg/litegraph')
const { registerPymssNodes, setSeparateStems } = await vite.ssrLoadModule('/src/litegraph/registerNodes.ts')
const { litegraphToComfy, toComfyJson, comfyLinksToLitegraph } = await vite.ssrLoadModule('/src/litegraph/graphAdapter.ts')

registerPymssNodes()

function buildSimpleGraph() {
  const graph = new LGraph()
  // Note: no LGraphCanvas here — serialization does not require rendering, and
  // the canvas constructor starts a render loop that needs DOM Image support.

  const load = LiteGraph.createNode('pymss_load_audio')
  load.pos = [100, 200]
  graph.add(load)

  const params = LiteGraph.createNode('pymss_mss_params')
  params.pos = [100, 400]
  graph.add(params)

  const sep = LiteGraph.createNode('mss_separate')
  sep.pos = [500, 300]
  setSeparateStems(sep, ['vocals', 'other'])
  graph.add(sep)

  const save = LiteGraph.createNode('pymss_save_audio')
  save.pos = [900, 300]
  graph.add(save)

  // Wire: load.audio -> sep.audio ; params.mss_params -> sep.params
  load.connect(0, sep, 0)
  params.connect(0, sep, 1)
  // sep stem outputs: [0]=vocals(Audio),[2]=other(Audio)
  sep.connect(0, save, 0)

  return graph
}

function pymssParse(jsonPath) {
  // Round-trip through pymss.graph.load_comfy_file in the repo's uv venv.
  const out = execFileSync(
    PY,
    ['-c', `import pymss.graph as g; d=g.load_comfy_file(${JSON.stringify(jsonPath)}); print('OK', len(d.nodes), sorted(n.type for n in d.nodes))`],
    { encoding: 'utf8' },
  ).trim()
  return out
}

test('litegraph serialize -> adapter -> pymss load_comfy_file (round-trip)', () => {
  const graph = buildSimpleGraph()
  const serialized = graph.serialize()
  const comfy = litegraphToComfy(serialized)

  // Structural assertions on the adapter output
  assert.ok(Array.isArray(comfy.nodes) && comfy.nodes.length === 4, 'four nodes serialized')
  assert.ok(Array.isArray(comfy.links) && comfy.links.length === 3, 'three links serialized')
  const types = comfy.nodes.map((n) => n.type).sort()
  assert.deepEqual(types, ['mss_separate', 'pymss_load_audio', 'pymss_mss_params', 'pymss_save_audio'])

  const sep = comfy.nodes.find((n) => n.type === 'mss_separate')
  assert.ok(sep, 'separate node present')
  assert.ok(Array.isArray(sep.widgets_values), 'separate node has widgets_values')
  assert.equal(sep.outputs.length, 4, 'separate node has 4 stem outputs (2 stems x audio/string)')

  const dir = mkdtempSync(join(tmpdir(), 'lg-rt-'))
  const jsonPath = join(dir, 'wf.json')
  writeFileSync(jsonPath, toComfyJson(serialized))

  const result = pymssParse(jsonPath)
  assert.match(result, /^OK 4 /, 'pymss.graph.load_comfy_file parsed the litegraph output')
  assert.ok(result.includes('mss_separate') && result.includes('pymss_save_audio'))
})

test('fixture files (real comfy-mss JSON) still parse through pymss', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lg-fix-'))
  for (const name of ['example_mss_separate', 'example_ensemble', 'example_vr_separate', 'example_custom_mss_separate', 'example_batch_separate']) {
    const jsonPath = join(dir, `${name}.json`)
    writeFileSync(jsonPath, readFixture(name))
    const result = pymssParse(jsonPath)
    assert.match(result, /^OK /, `${name} parsed`)
  }
})

test('a real comfy-mss workflow file loads into the litegraph editor and round-trips', () => {
  // The user-facing import path: parse a comfy-mss JSON (like testflow.json),
  // configure the litegraph graph with it, serialize back, and confirm the
  // pymss DAG still parses it with all nodes/links intact.
  const source = JSON.parse(readFileSync(join(__dirname, '..', 'testflow.json'), 'utf8'))
  const graph = new LGraph()
  graph.configure({
    nodes: source.nodes,
    links: comfyLinksToLitegraph(source.links),
    last_node_id: source.last_node_id,
    last_link_id: source.last_link_id,
    groups: source.groups || [],
    version: 1,
  })
  const serialized = graph.serialize()
  const comfy = litegraphToComfy(serialized)

  assert.equal(comfy.nodes.length, source.nodes.length,
    `all ${source.nodes.length} nodes load into the editor`)
  assert.equal(comfy.links.length, source.links.length,
    `all ${source.links.length} links survive the round-trip`)

  const dir = mkdtempSync(join(tmpdir(), 'lg-tf-'))
  const jsonPath = join(dir, 'wf.json')
  writeFileSync(jsonPath, toComfyJson(serialized))
  const result = pymssParse(jsonPath)
  assert.match(result, /^OK /, 'round-tripped graph still parses in pymss')
})

function readFixture(name) {
  return readFileSync(join(__dirname, 'fixtures/comfy-mss', `${name}.json`), 'utf8')
}
