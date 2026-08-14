<script setup lang="ts">
/**
 * Litegraph-based node editor for comfy-mss workflows.
 *
 * Replaces the hand-written WorkflowNodeEditor.vue canvas. The graph is edited
 * directly as native comfy-mss JSON; serialize() output is handed to the parent
 * via v-model:definition, and pymss.graph.load_comfy_file consumes it verbatim.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { LGraph, LGraphCanvas, LiteGraph, type LGraphNode } from '@comfyorg/litegraph'
import '@comfyorg/litegraph/style.css'
import { registerPymssNodes, setSeparateStems, NODE_SPECS, BUILTIN_SPECS } from '@/litegraph/registerNodes'
import { litegraphToComfy, comfyLinksToLitegraph } from '@/litegraph/graphAdapter'
import type { ModelEntry } from '@/stores/model'
import type { NodeSpec } from '@/litegraph/nodeSpecs'

// All node specs the palette offers (pymss nodes + ComfyUI builtin audio/string nodes).
const ALL_SPECS: Record<string, NodeSpec> = { ...NODE_SPECS, ...BUILTIN_SPECS }

const props = defineProps<{
  modelOptions: { label: string; value: string }[]
  models: ModelEntry[]
  formError?: string
  canSave?: boolean
}>()
const definition = defineModel<Record<string, unknown>>('definition', { required: true })
const emit = defineEmits<{
  save: [definition: Record<string, unknown>]
  close: []
}>()

const { t } = useI18n()
const canvasEl = ref<HTMLCanvasElement | null>(null)
const graphRef = shallowRef<LGraph | null>(null)
const canvasRef = shallowRef<LGraphCanvas | null>(null)
const showPalette = ref(false)
const paletteQuery = ref('')
const ready = ref(false)

// --- undo/redo (serialize snapshots) --------------------------------------
const undoStack = shallowRef<{ past: any[]; future: any[] }>({ past: [], future: [] })
let lastSnapshot = ''
function snapshotForHistory() {
  const graph = graphRef.value
  if (!graph) return
  const snap = JSON.stringify(graph.serialize())
  if (snap === lastSnapshot) return
  if (lastSnapshot) {
    undoStack.value = { past: [...undoStack.value.past.slice(-49), lastSnapshot], future: [] }
  }
  lastSnapshot = snap
}
function restoreSnapshot(snap: string) {
  const graph = graphRef.value
  if (!graph) return
  const data = JSON.parse(snap)
  graph.configure({
    ...data,
    links: Array.isArray(data.links) ? comfyLinksToLitegraph(data.links) : data.links,
  })
  for (const n of (graph.nodes as any[])) syncSeparateNodeStems(n)
  lastSnapshot = snap
  scheduleSnap()
}
function undo() {
  const { past, future } = undoStack.value
  if (!past.length) return
  const current = lastSnapshot
  const prev = past[past.length - 1]
  undoStack.value = { past: past.slice(0, -1), future: current ? [current, ...future].slice(0, 50) : future }
  restoreSnapshot(prev)
}
function redo() {
  const { past, future } = undoStack.value
  if (!future.length) return
  const current = lastSnapshot
  const next = future[0]
  undoStack.value = { past: current ? [...past, current] : past, future: future.slice(1) }
  restoreSnapshot(next)
}
function onCanvasKey(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey
  if (mod && (e.key === 'z' || e.key === 'Z') && !e.shiftKey) { e.preventDefault(); undo() }
  else if (mod && ((e.key === 'z' && e.shiftKey) || e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo() }
}
const canUndo = computed(() => undoStack.value.past.length > 0)
const canRedo = computed(() => undoStack.value.future.length > 0)

// --- theme: dark to match pymss-studio -------------------------------------
function applyTheme() {
  LiteGraph.NODE_DEFAULT_BGCOLOR = '#262b33'
  LiteGraph.NODE_DEFAULT_COLOR = '#cfd3da'
  LiteGraph.LINK_COLOR = '#5b8def'
  LiteGraph.ROUND_RADIUS = 6
  ;(LiteGraph as any).NODE_DEFAULT_TITLECOLOR = '#e6e8eb'
  ;(LiteGraph as any).NODE_TITLE_BOXCOLOR = '#5b8def'
  ;(LiteGraph as any).NODE_TEXT_COLOR = '#e6e8eb'
  ;(LiteGraph as any).EVENT_LINK_COLOR = '#9b6dff'
}

// --- model -> stems lookup for separate nodes ------------------------------
function stemsForModel(modelName: string): string[] {
  const m = props.models.find((x) => x.name === modelName || x.aliases?.includes(modelName))
  if (!m) return []
  // Catalog models expose target_stem; two-stem models split into target/rest.
  const target = (m.targetStem || '').trim()
  if (target) {
    // Heuristic: VR/mss instrumental models produce {target, rest}; ensemble
    // multi-stem models list configInstruments. Prefer configInstruments if set.
    const instruments = (m.configInstruments || '').split(',').map((s) => s.trim()).filter(Boolean)
    if (instruments.length >= 2) return instruments
    return [target, target.toLowerCase() === 'vocals' ? 'instrumental' : 'other']
  }
  return ['stem_1', 'stem_2']
}

function syncSeparateNodeStems(node: LGraphNode) {
  const spec = ALL_SPECS[String(node.type)]
  if (!spec?.dynamicStems) return
  // Nodes loaded from a serialized graph already carry their real stem output
  // ports (e.g. "vocals (Audio)"); never rebuild those — that would sever the
  // links. Only placeholder ports (stem_1/stem_2) are replaced by the model's
  // stems when the model is known.
  const outputs = node.outputs || []
  const hasRealOutputs = outputs.some((o) => !String(o.name || '').startsWith('stem_'))
  if (hasRealOutputs) return
  const modelName = String((node as any).properties?.model_name || '')
  const stems = stemsForModel(modelName)
  if (stems.length) setSeparateStems(node, stems)
}

// --- node creation ---------------------------------------------------------
function addNode(type: string, x?: number, y?: number) {
  const graph = graphRef.value
  if (!graph) return
  const node = LiteGraph.createNode(type)
  if (!node) return
  const cx = canvasRef.value?.viewport || [0, 0]
  node.pos = [x ?? (cx[0] + 200), y ?? (cx[1] + 150)]
  graph.add(node)
  syncSeparateNodeStems(node)
  ;(canvasRef.value as any)?.setDirty(true, true)
}

// --- search palette --------------------------------------------------------
const paletteCategories = computed(() => {
  const groups: Record<string, { type: string; title: string }[]> = {}
  for (const spec of Object.values(ALL_SPECS)) {
    const cat = spec.category || 'pymss'
    ;(groups[cat] ||= []).push({ type: spec.type, title: spec.title })
  }
  return Object.entries(groups).map(([category, items]) => ({ category, items }))
})
const paletteFiltered = computed(() => {
  const q = paletteQuery.value.trim().toLowerCase()
  if (!q) return paletteCategories.value
  return paletteCategories.value
    .map((g) => ({ ...g, items: g.items.filter((i) => i.title.toLowerCase().includes(q) || i.type.toLowerCase().includes(q)) }))
    .filter((g) => g.items.length)
})

// --- (de)serialize ---------------------------------------------------------
function snapshotDefinition(): Record<string, unknown> {
  const graph = graphRef.value
  if (!graph) return {}
  return litegraphToComfy(graph.serialize()) as unknown as Record<string, unknown>
}

function loadDefinition(def: Record<string, unknown>) {
  const graph = graphRef.value
  if (!graph) return
  graph.clear()
  const nodes = Array.isArray(def.nodes) ? def.nodes : []
  const links = Array.isArray(def.links) ? def.links : []
  // Configure from a comfy-shaped object litegraph can ingest.
  const data: any = {
    nodes,
    links: Array.isArray(links) ? comfyLinksToLitegraph(links) : links,
    last_node_id: def.last_node_id ?? (nodes.length ? Math.max(...nodes.map((n: any) => Number(n.id))) : 0),
    last_link_id: def.last_link_id ?? (links.length ? Math.max(...links.map((l: any) => Number(l[0]))) : 0),
    groups: [],
    version: 1,
  }
  graph.configure(data)
  // After configure, rebuild dynamic stem outputs for separate nodes.
  for (const n of graph.nodes as any[]) syncSeparateNodeStems(n)
}

// --- lifecycle -------------------------------------------------------------
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  registerPymssNodes()
  applyTheme()
  if (!canvasEl.value) return
  const graph = new LGraph()
  const canvas = new LGraphCanvas(canvasEl.value, graph)
  graphRef.value = graph
  canvasRef.value = canvas
  // Hide the default search-on-double-click; we use our own palette.
  // 保留 litegraph 默认交互: 双击空白/拖线释放弹节点搜索框,右键弹菜单。
  // 样式由 @comfyorg/litegraph/style.css 提供(在组件 <style> 外全局引入)。
  // Track link/property edits so separate node stems follow the chosen model.
  graph.onNodeAdded = (node: any) => { /* stems set via watcher below */ }
  resizeObserver = new ResizeObserver(() => (canvas as any).resize())
  resizeObserver.observe(canvasEl.value.parentElement || canvasEl.value)
  canvasEl.value.addEventListener('keydown', onCanvasKey)
  // Load existing definition (e.g. reopening an editor) or seed a starter graph.
  if (definition.value && Object.keys(definition.value).length) {
    loadDefinition(definition.value)
  } else {
    seedStarterGraph()
  }
  graph.start()
  ready.value = true
  // Push the first snapshot up so the parent has a clean comfy dict immediately.
  definition.value = snapshotDefinition()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  canvasEl.value?.removeEventListener('keydown', onCanvasKey)
  try { graphRef.value?.stop?.() } catch { /* ignore */ }
  canvasRef.value?.stopRendering?.()
  graphRef.value = null
  canvasRef.value = null
})

function seedStarterGraph() {
  const graph = graphRef.value
  if (!graph) return
  const load = LiteGraph.createNode('pymss_load_audio'); if (!load) return
  load.pos = [80, 200]; graph.add(load)
  const params = LiteGraph.createNode('pymss_mss_params'); if (!params) return
  params.pos = [80, 400]; graph.add(params)
  const sep = LiteGraph.createNode('mss_separate'); if (!sep) return
  sep.pos = [460, 280]; graph.add(sep)
  const save = LiteGraph.createNode('pymss_save_audio'); if (!save) return
  save.pos = [840, 280]; graph.add(save)
  load.connect(0, sep, 0)
  params.connect(0, sep, 1)
  sep.connect(0, save, 0)
}

// Keep separate-node stem outputs in sync when the model_name widget changes.
watch(() => props.models, () => {
  for (const n of (graphRef.value?.nodes || []) as any[]) syncSeparateNodeStems(n)
}, { deep: false })

// Propagate canvas edits up to the parent v-model (debounced via rAF).
let pendingSnap = 0
function scheduleSnap() {
  if (pendingSnap) return
  pendingSnap = requestAnimationFrame(() => {
    pendingSnap = 0
    definition.value = snapshotDefinition()
    snapshotForHistory()
  })
}
watch(ready, (v) => {
  if (!v || !graphRef.value) return
  ;(graphRef.value as any).onAfterChange = scheduleSnap
  ;(graphRef.value as any).onGraphConfigured = scheduleSnap
})

function onSave() {
  definition.value = snapshotDefinition()
  emit('save', definition.value)
}
function onClose() {
  emit('close')
}
function onAddNodeClick(type: string) {
  addNode(type)
  showPalette.value = false
  paletteQuery.value = ''
  scheduleSnap()
}
</script>

<template>
  <div class="litegraph-editor">
    <div class="toolbar">
      <n-button size="small" @click="showPalette = !showPalette">{{ t('workflows.addNode') || 'Add node' }}</n-button>
      <n-button size="small" :disabled="!canUndo" @click="undo">{{ t('common.undo') || 'Undo' }}</n-button>
      <n-button size="small" :disabled="!canRedo" @click="redo">{{ t('common.redo') || 'Redo' }}</n-button>
      <n-button size="small" @click="onSave" :disabled="!props.canSave" type="primary">{{ t('common.save') }}</n-button>
      <n-button size="small" @click="onClose">{{ t('common.close') }}</n-button>
      <span v-if="props.formError" class="err">{{ props.formError }}</span>
    </div>

    <div v-if="showPalette" class="palette">
      <input v-model="paletteQuery" class="palette-input" placeholder="Search nodes..." autofocus />
      <div class="palette-list">
        <div v-for="g in paletteFiltered" :key="g.category" class="palette-group">
          <div class="palette-cat">{{ g.category }}</div>
          <button v-for="item in g.items" :key="item.type" class="palette-item" @click="onAddNodeClick(item.type)">
            {{ item.title }}
          </button>
        </div>
      </div>
    </div>

    <div class="canvas-wrap">
      <canvas ref="canvasEl" class="lg-canvas" />
    </div>
  </div>
</template>

<style scoped>
.litegraph-editor { display: flex; flex-direction: column; height: 100%; background: #16181d; color: #e6e8eb; }
.toolbar { display: flex; align-items: center; gap: 8px; padding: 8px; border-bottom: 1px solid #2a2e36; background: #1c1f26; }
.err { color: #ff6b6b; font-size: 12px; margin-left: auto; }
.palette { position: absolute; top: 48px; left: 12px; width: 260px; max-height: 60%; background: #1c1f26; border: 1px solid #3a3f4a; border-radius: 6px; z-index: 10; display: flex; flex-direction: column; }
.palette-input { margin: 8px; padding: 6px 8px; background: #16181d; border: 1px solid #3a3f4a; color: #e6e8eb; border-radius: 4px; }
.palette-list { overflow-y: auto; padding: 0 8px 8px; }
.palette-cat { color: #8b92a0; font-size: 11px; text-transform: uppercase; padding: 8px 4px 4px; }
.palette-item { display: block; width: 100%; text-align: left; background: transparent; border: none; color: #cfd3da; padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 13px; }
.palette-item:hover { background: #2a2e36; }
.canvas-wrap { position: relative; flex: 1; overflow: hidden; }
.lg-canvas { width: 100%; height: 100%; display: block; }
</style>
