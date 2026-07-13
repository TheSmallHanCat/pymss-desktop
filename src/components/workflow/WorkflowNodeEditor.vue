<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from 'vue-i18n'
import { invoke } from '@tauri-apps/api/core'
import { AddOutline, ArrowRedoOutline, ArrowUndoOutline, CloseOutline, CopyOutline, RemoveOutline, SearchOutline, SettingsOutline, TrashOutline } from '@vicons/ionicons5'
import type { ModelEntry } from '@/stores/model'
import type {
  WorkflowCanvasPoint,
  WorkflowDefinitionDraft,
  WorkflowNodeEditorUi,
  WorkflowNoteDraft,
  WorkflowSaveTargetDraft,
  WorkflowStepDraft,
  WorkflowUtilityNodeDraft,
  WorkflowUtilityNodeKind,
} from '@/utils/workflowDefinition'
import {
  buildWorkflowDefinition,
  buildWorkflowConsumedValueSetForDraft,
  createDefaultWorkflowNodeEditorUi,
  createStepDraft,
  createWorkflowNoteDraft,
  createWorkflowUtilityNodeDraft,
  ensureWorkflowStepIds,
  getWorkflowStepDisplayId,
  getWorkflowValidationSummary,
  getWorkflowUtilityNodeInputMissingCount,
  hydrateWorkflowDefinition,
  parseModelStems,
} from '@/utils/workflowDefinition'
import {
  readWorkflowGraphDefinition,
  serializeWorkflowGraphDefinition,
  type WorkflowGraphDefinition,
} from '@/utils/workflowGraph'

const definition = defineModel<Record<string, unknown>>('definition', { required: true })
const props = defineProps<{
  modelOptions: { label: string; value: string }[]
  models: ModelEntry[]
  formError?: string
  canSave?: boolean
}>()
const emit = defineEmits<{
  save: [definition: Record<string, unknown>]
  close: []
}>()

type GraphPoint = { x: number; y: number }
type GraphConnection = {
  id: string
  path: string
  className: string
  kind: 'step-input' | 'utility-input' | 'save' | 'pending'
  stepId?: string
  utilityId?: string
  utilityPortId?: string
}
type DragState = {
  type: 'pan' | 'node' | 'note' | 'selection' | 'marquee'
  pointerId: number
  startClientX: number
  startClientY: number
  initialViewport?: { x: number; y: number; k: number }
  nodeKey?: string
  noteId?: string
  initialPoint?: WorkflowCanvasPoint
  initialWorldPoint?: WorkflowCanvasPoint
  selectionKeys?: string[]
  initialSelectionPoints?: Record<string, WorkflowCanvasPoint>
}
type ContextMenuState = {
  show: boolean
  x: number
  y: number
  world: WorkflowCanvasPoint | null
  mode: 'add' | 'selection'
}
type PaletteKind = 'step' | 'note' | WorkflowUtilityNodeKind
type ScanAudioPathsResult = {
  files: string[]
  warnings: string[]
}
type WorkflowClipboard = {
  steps: Array<{ step: WorkflowStepDraft; position: WorkflowCanvasPoint }>
  utilities: Array<{ node: WorkflowUtilityNodeDraft }>
  notes: WorkflowNoteDraft[]
}
type WorkflowValidationIssue = {
  message: string
  targetKey: string
}

const { t } = useI18n()
const message = useMessage()

const graphDefinition = ref<WorkflowGraphDefinition>(readWorkflowGraphDefinition(definition.value || {}))
let lastSyncedDefinitionJson = JSON.stringify(serializeWorkflowGraphDefinition(graphDefinition.value))

const draftState = computed<WorkflowDefinitionDraft>(() => hydrateWorkflowDefinition(serializeWorkflowGraphDefinition(graphDefinition.value)))
const steps = computed<WorkflowStepDraft[]>(() => draftState.value.steps)
const editorUi = computed<WorkflowNodeEditorUi>(() => draftState.value.ui)

const GRAPH_NODE_WIDTH = 296
const GRAPH_STEP_GAP = 318
const GRAPH_STEP_START_X = 384
const GRAPH_TOP_Y = 118
const GRAPH_INPUT_X = 72
const GRAPH_SAVE_GAP = 420
const NOTE_WIDTH = 244
const NOTE_MIN_HEIGHT = 72
const NOTE_MAX_HEIGHT = 320
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2.5
const ZOOM_STEP = 1.14
const GRID_SIZE = 48
const WORLD_PADDING = 360
const HISTORY_LIMIT = 80
const HISTORY_GROUP_DELAY = 320

let dragState: DragState | null = null
let frame = 0
let measureFrame = 0
let queuedPointer: { clientX: number; clientY: number } | null = null
let historyGroupTimer: ReturnType<typeof setTimeout> | null = null
let historyGrouping = false
let historyReady = false
let currentHistoryJson = JSON.stringify(serializeWorkflowGraphDefinition(graphDefinition.value))
let currentHistoryContentJson = historyContentJsonFromJson(currentHistoryJson)
const spacePanning = ref(false)
const undoStack = ref<string[]>([])
const redoStack = ref<string[]>([])
const graphClipboard = ref<WorkflowClipboard | null>(null)
let clipboardPasteCount = 0

const selectedGraphNode = ref('input')
const selectedGraphNodes = ref<string[]>(['input'])
const pendingConnection = ref<{ value: string; label: string } | null>(null)
const hoveredEdgeId = ref('')
const canvasViewportRef = ref<HTMLElement | null>(null)
const minimapRef = ref<HTMLElement | null>(null)
const canvasMouseWorld = ref<WorkflowCanvasPoint | null>(null)
const portPositions = ref<Record<string, GraphPoint>>({})
const viewportMetrics = ref({ width: 1, height: 1 })
const contextMenu = ref<ContextMenuState>({ show: false, x: 0, y: 0, world: null, mode: 'add' })
const selectionMarquee = ref<{ left: number; top: number; width: number; height: number } | null>(null)
const paletteOpen = ref(false)
const paletteSearch = ref('')
const paletteInsertWorld = ref<WorkflowCanvasPoint | null>(null)
const stepConfigModalStepId = ref('')
const utilityConfigModalId = ref('')
const saveConfigOpen = ref(false)
const hasMultipleSelection = computed(() => selectedGraphNodes.value.length > 1)
const movableSelectedCount = computed(() => movableSelectionKeys().length)
const canAlignSelection = computed(() => movableSelectedCount.value >= 2)
const canDistributeSelection = computed(() => movableSelectedCount.value >= 3)
const hasDuplicableSelection = computed(() => duplicableSelectionKeys().length > 0)
const hasRemovableSelection = computed(() => removableSelectionKeys().length > 0)
const canUndo = computed(() => undoStack.value.length > 0)
const canRedo = computed(() => redoStack.value.length > 0)
const canPasteGraphNodes = computed(() => Boolean(graphClipboard.value && (graphClipboard.value.steps.length || graphClipboard.value.utilities.length || graphClipboard.value.notes.length)))
const pendingConnectionTargetLabel = computed(() => {
  const target = pendingConnectionTarget.value
  if (!target) return ''
  if (target.kind === 'step' && target.stepId) {
    const index = steps.value.findIndex(step => step.id === target.stepId)
    if (index >= 0) return stepDisplayId(index)
  }
  if (target.kind === 'utility' && target.utilityId && target.utilityPortId) {
    const node = utilityNodes.value.find(item => item.id === target.utilityId)
    if (!node) return ''
    return `${utilityNodeDisplayLabel(node)} · ${utilityInputLabel(node, target.utilityPortId)}`
  }
  return ''
})
const selectionBounds = computed(() => {
  if (!hasMultipleSelection.value) return null
  const bounds = selectedGraphNodes.value
    .map(key => nodeBoundsBySelectionKey(key))
    .filter((item): item is { x: number; y: number; width: number; height: number } => Boolean(item))
  if (!bounds.length) return null
  const minX = Math.min(...bounds.map(item => item.x))
  const minY = Math.min(...bounds.map(item => item.y))
  const maxX = Math.max(...bounds.map(item => item.x + item.width))
  const maxY = Math.max(...bounds.map(item => item.y + item.height))
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY }
})
const selectionToolbarStyle = computed(() => {
  const bounds = selectionBounds.value
  if (!bounds) return null
  const scale = viewport.value.k || 1
  const estimatedWidth = Math.min(620, Math.max(360, viewportMetrics.value.width - 32))
  const centerX = viewport.value.x + (bounds.minX + bounds.width / 2) * scale
  const left = Math.max(14, Math.min(centerX - estimatedWidth / 2, viewportMetrics.value.width - estimatedWidth - 14))
  const preferredTop = viewport.value.y + bounds.minY * scale - 58
  const fallbackTop = viewport.value.y + bounds.maxY * scale + 14
  const top = preferredTop >= 14 ? preferredTop : Math.min(Math.max(14, fallbackTop), Math.max(14, viewportMetrics.value.height - 52))
  return {
    left: `${Math.round(left)}px`,
    top: `${Math.round(top)}px`,
    maxWidth: `${Math.round(estimatedWidth)}px`,
  }
})

const noteColorOptions = [
  { label: computed(() => t('workflows.noteColorAmber')), value: 'amber' },
  { label: computed(() => t('workflows.noteColorBlue')), value: 'blue' },
  { label: computed(() => t('workflows.noteColorGreen')), value: 'green' },
  { label: computed(() => t('workflows.noteColorRose')), value: 'rose' },
]

// Inline note editing (click-to-edit, mirrors the workflow name field pattern):
// double-click a note's title/content to edit it in place instead of a panel.
const editingNoteField = ref<{ noteId: string; field: 'title' | 'content' } | null>(null)
const noteEditInputRef = ref<HTMLInputElement | HTMLTextAreaElement | Array<HTMLInputElement | HTMLTextAreaElement> | null>(null)

const NOTE_DEFAULT_FONT_SIZE = 13
const noteFontSizeOptions = [12, 13, 14, 16, 18, 20, 24]
const noteFontFamilyOptions = [
  { label: computed(() => t('workflows.noteFontDefault')), value: '' },
  { label: computed(() => t('workflows.noteFontSans')), value: 'sans' },
  { label: computed(() => t('workflows.noteFontSerif')), value: 'serif' },
  { label: computed(() => t('workflows.noteFontMono')), value: 'mono' },
]
const NOTE_FONT_FAMILY_STACKS: Record<string, string> = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
}
function noteFontFamilyStack(value?: string) {
  return value && NOTE_FONT_FAMILY_STACKS[value] ? NOTE_FONT_FAMILY_STACKS[value] : ''
}
function noteFontSize(note: WorkflowNoteDraft) {
  return note.fontSize && note.fontSize > 0 ? note.fontSize : NOTE_DEFAULT_FONT_SIZE
}
function noteTextStyle(note: WorkflowNoteDraft) {
  const family = noteFontFamilyStack(note.fontFamily)
  return {
    fontSize: `${noteFontSize(note)}px`,
    ...(family ? { fontFamily: family } : {}),
  }
}

const utilityNodes = computed<WorkflowUtilityNodeDraft[]>(() => draftState.value.utilityNodes || [])
const consumedValueSet = computed(() => buildWorkflowConsumedValueSetForDraft(steps.value, utilityNodes.value))
const saveTargets = computed<WorkflowSaveTargetDraft[]>(() => draftState.value.saveTargets || [])
const saveOutputs = computed(() => {
  const stepItems = steps.value.flatMap((step, stepIndex) => step.stems
    .filter(stem => !consumedValueSet.value.has(`${step.id}.${stem}`))
    .map(stem => ({
      key: `${step.id}.${stem}`,
      source: `${step.id}.${stem}`,
      type: 'step' as const,
      stepIndex,
      stem,
      label: `${stepDisplayId(stepIndex)}.${stem}`,
      outputDir: step.save?.[stem] || stem,
    })))
  const utilityItems = utilityNodes.value
    .filter(node => !consumedValueSet.value.has(`utility:${node.id}`))
    .map(node => ({
      key: `utility:${node.id}`,
      source: `utility:${node.id}`,
      type: 'utility' as const,
      utilityId: node.id,
      label: utilityNodeDisplayLabel(node),
      outputDir: saveTargets.value.find(item => item.source === `utility:${node.id}`)?.outputDir
        || utilityNodeDefaultOutputDir(node),
    }))
  return [...stepItems, ...utilityItems]
})
const saveNodeX = computed(() => GRAPH_STEP_START_X + Math.max(1, steps.value.length) * GRAPH_STEP_GAP + GRAPH_SAVE_GAP)
const notes = computed(() => editorUi.value.notes || [])
const collapsedStepIds = computed(() => editorUi.value.collapsedStepIds || [])
const selectedGraphStepId = computed(() => {
  const match = selectedGraphNode.value.match(/^step:(.+)$/)
  return match ? match[1] : ''
})
const selectedGraphNoteId = computed(() => {
  const match = selectedGraphNode.value.match(/^note:(.+)$/)
  return match ? match[1] : ''
})
const selectedGraphUtilityId = computed(() => {
  const match = selectedGraphNode.value.match(/^utility:(.+)$/)
  return match ? match[1] : ''
})
const selectedGraphNote = computed(() => notes.value.find(note => note.id === selectedGraphNoteId.value) || null)
const selectedUtilityNode = computed(() => utilityNodes.value.find(node => node.id === selectedGraphUtilityId.value) || null)
const utilityConfigNode = computed(() => utilityNodes.value.find(node => node.id === utilityConfigModalId.value) || null)
const utilityConfigNodeId = computed(() => utilityConfigNode.value?.id || '')
const utilityConfigKind = computed<WorkflowUtilityNodeKind>(() => utilityConfigNode.value?.kind || 'audio_normalize')
const utilityConfigData = computed<Record<string, unknown>>(() => utilityConfigNode.value?.data || {})
const utilityConfigInputCount = computed(() => Math.max(2, Math.min(10, Number(utilityConfigData.value.inputCount) || 2)))
const batchInputNodes = computed(() => utilityNodes.value.filter(node => node.kind === 'load_audio_batch'))
const validationSummary = computed(() => getWorkflowValidationSummary(currentDefinitionSnapshot()))
const workflowValidationIssues = computed<WorkflowValidationIssue[]>(() => {
  const issues: WorkflowValidationIssue[] = []
  if (validationSummary.value.batchInputMultipleUnsupported) {
    issues.push({ message: t('workflows.batchInputMultipleUnsupported'), targetKey: validationTargetForFirstBatchInputNode() })
  }
  if (validationSummary.value.batchInputMissingFolderCount > 0) {
    issues.push({ message: t('workflows.batchInputFolderMissing', { count: validationSummary.value.batchInputMissingFolderCount }), targetKey: validationTargetForFirstMissingBatchInputNode() })
  }
  if (validationSummary.value.utilityInputMissingCount > 0) {
    issues.push({ message: t('workflows.utilityInputsRequired', { count: validationSummary.value.utilityInputMissingCount }), targetKey: validationTargetForFirstMissingUtilityInput() })
  }
  if (validationSummary.value.danglingConnectionCount > 0) {
    issues.push({ message: t('workflows.workflowDanglingConnections', { count: validationSummary.value.danglingConnectionCount }), targetKey: validationTargetForFirstDanglingConnection() })
  }
  if (validationSummary.value.invalidConnectionCount > 0) {
    issues.push({ message: t('workflows.workflowInvalidConnections', { count: validationSummary.value.invalidConnectionCount }), targetKey: validationTargetForFirstInvalidConnection() })
  }
  if (validationSummary.value.duplicateInputConnectionCount > 0) {
    issues.push({ message: t('workflows.workflowDuplicateInputConnections', { count: validationSummary.value.duplicateInputConnectionCount }), targetKey: validationTargetForFirstDuplicateInputConnection() })
  }
  if (validationSummary.value.graphCycleDetected) {
    issues.push({ message: t('workflows.workflowCycleDetected'), targetKey: validationTargetForExecutableNode() })
  }
  if (validationSummary.value.noSaveOutputs) {
    issues.push({ message: t('workflows.workflowNoSaveOutputs'), targetKey: 'save' })
  }
  return issues
})
const stepConfigStep = computed(() => steps.value.find(step => step.id === stepConfigModalStepId.value) || null)
const stepConfigStepIndex = computed(() => steps.value.findIndex(step => step.id === stepConfigModalStepId.value))
const stepConfigStepId = computed(() => stepConfigStep.value?.id || '')
const stepConfigStepModel = computed(() => stepConfigStep.value?.model || '')
const stepConfigStepInput = computed(() => stepConfigStep.value?.input || '')
const stepConfigStepOverlap = computed<number | null>(() => stepConfigStep.value?.overlapSize ?? null)
const stepConfigStepStems = computed(() => stepConfigStep.value?.stems || [])
const stepConfigStepInputOptions = computed(() => stepConfigStepIndex.value >= 0 ? inputOptions(stepConfigStepIndex.value) : [])
const stepConfigStepStemOptions = computed(() => stepConfigStep.value ? modelStemOptions(stepConfigStep.value.model) : [])
const stepConfigStepAvailableStemValues = computed(() => stepConfigStepStemOptions.value.map(item => item.value))
const utilityBatchPreview = ref<ScanAudioPathsResult | null>(null)
const utilityBatchPreviewLoading = ref(false)
const utilityBatchPreviewError = ref('')
const batchInputNodeTaskCounts = ref<Record<string, number | null>>({})
let utilityBatchPreviewToken = 0
let utilityBatchPreviewTimer: ReturnType<typeof setTimeout> | null = null
let batchInputNodeCountToken = 0
let batchInputNodeCountTimer: ReturnType<typeof setTimeout> | null = null
const paletteItems = computed(() => {
  const keyword = paletteSearch.value.trim().toLowerCase()
  const items = [
    {
      kind: 'step' as const,
      title: t('workflows.addSeparationNode'),
      desc: t('workflows.paletteStepDesc'),
    },
    {
      kind: 'note' as const,
      title: t('workflows.addNote'),
      desc: t('workflows.paletteNoteDesc'),
    },
    {
      kind: 'load_audio_batch' as const,
      title: t('workflows.batchInputNode'),
      desc: t('workflows.paletteBatchInputDesc'),
    },
    {
      kind: 'audio_ensemble' as const,
      title: t('workflows.audioEnsembleNode'),
      desc: t('workflows.paletteAudioEnsembleDesc'),
    },
    {
      kind: 'audio_invert_phase' as const,
      title: t('workflows.invertPhaseNode'),
      desc: t('workflows.paletteInvertPhaseDesc'),
    },
    {
      kind: 'audio_normalize' as const,
      title: t('workflows.audioNormalizeNode'),
      desc: t('workflows.paletteAudioNormalizeDesc'),
    },
  ]
  if (!keyword) return items
  return items.filter(item => `${item.title} ${item.desc}`.toLowerCase().includes(keyword))
})

function graphNodeById(id: string) {
  return graphDefinition.value.graph.nodes.find(node => node.id === id) || null
}

function mutateDraft(mutator: (draft: WorkflowDefinitionDraft) => void) {
  const currentSnapshot = serializeWorkflowGraphDefinition(graphDefinition.value)
  const currentSerialized = JSON.stringify(currentSnapshot)
  const next = hydrateWorkflowDefinition(currentSnapshot)
  const beforeDraftJson = JSON.stringify(next)
  mutator(next)
  if (JSON.stringify(next) === beforeDraftJson) return
  const nextDefinition = buildWorkflowDefinition(next)
  if (JSON.stringify(nextDefinition) === currentSerialized) return
  graphDefinition.value = readWorkflowGraphDefinition(nextDefinition)
}

function updateStepConfigModel(value: string) {
  if (!stepConfigStepId.value) return
  updateStepModel(stepConfigStepId.value, value)
}

function updateStepConfigInput(value: string) {
  const stepId = stepConfigStepId.value
  if (!stepId) return
  mutateDraft((next) => {
    const target = next.steps.find(item => item.id === stepId)
    if (!target) return
    target.input = value
  })
}

function updateStepConfigOverlap(value: number | null) {
  if (!stepConfigStepId.value) return
  updateStepOverlap(stepConfigStepId.value, value)
}

function updateStepConfigStems(value: string[]) {
  if (!stepConfigStepId.value) return
  updateStepStems(stepConfigStepId.value, value)
}

const viewport = computed({
  get: () => graphDefinition.value.graph.viewport,
  set: (value: { x: number; y: number; k: number }) => {
    graphDefinition.value = {
      ...graphDefinition.value,
      graph: {
        ...graphDefinition.value.graph,
        viewport: {
          x: Math.round(value.x),
          y: Math.round(value.y),
          k: clampZoom(value.k),
        },
      },
    }
  },
})

const canvasBounds = computed(() => {
  const blockRects = [
    {
      x: nodePosition('input').x,
      y: nodePosition('input').y,
      width: GRAPH_NODE_WIDTH,
      height: 120,
    },
    {
      x: nodePosition('save').x,
      y: nodePosition('save').y,
      width: GRAPH_NODE_WIDTH,
      height: saveNodeHeight(),
    },
    ...steps.value.map(step => ({
      x: nodePosition(step.id).x,
      y: nodePosition(step.id).y,
      width: GRAPH_NODE_WIDTH,
      height: stepNodeHeight(step),
    })),
    ...utilityNodes.value.map(node => ({
      x: nodePosition(node.id).x,
      y: nodePosition(node.id).y,
      width: utilityNodeWidth(node.kind),
      height: utilityNodeHeight(node),
    })),
    ...notes.value.map(note => ({
      x: note.x,
      y: note.y,
      width: NOTE_WIDTH,
      height: noteHeight(note),
    })),
  ]
  const xs = blockRects.map(item => item.x).filter(Number.isFinite)
  const ys = blockRects.map(item => item.y).filter(Number.isFinite)
  const rights = blockRects.map(item => item.x + item.width).filter(Number.isFinite)
  const bottoms = blockRects.map(item => item.y + item.height).filter(Number.isFinite)
  const minX = (xs.length ? Math.min(...xs) : 0) - WORLD_PADDING
  const minY = (ys.length ? Math.min(...ys) : 0) - WORLD_PADDING
  const maxX = (rights.length ? Math.max(...rights) : 0) + WORLD_PADDING
  const maxY = (bottoms.length ? Math.max(...bottoms) : 0) + WORLD_PADDING
  return {
    minX,
    minY,
    width: Math.max(1600, maxX - minX),
    height: Math.max(1000, maxY - minY),
  }
})
const graphCanvasStyle = computed(() => ({
  left: `${canvasBounds.value.minX}px`,
  top: `${canvasBounds.value.minY}px`,
  width: `${canvasBounds.value.width}px`,
  height: `${canvasBounds.value.height}px`,
}))
const viewportStyle = computed(() => {
  const gridSize = GRID_SIZE * viewport.value.k
  return {
    '--viewport-x': `${viewport.value.x}px`,
    '--viewport-y': `${viewport.value.y}px`,
    '--grid-size': `${gridSize}px`,
    '--grid-x': `${viewport.value.x % gridSize}px`,
    '--grid-y': `${viewport.value.y % gridSize}px`,
  }
})
const zoomLayerStyle = computed(() => ({
  transform: `scale(${viewport.value.k})`,
  willChange: 'transform',
}))
const zoomPercent = computed(() => Math.round(viewport.value.k * 100))
function utilityInputPortIds(node: WorkflowUtilityNodeDraft) {
  if (node.kind === 'audio_ensemble') {
    const count = Math.max(2, Math.min(10, Number(node.data.inputCount) || 2))
    return Array.from({ length: count }, (_value, index) => `input:${index}`)
  }
  if (node.kind === 'audio_invert_phase' || node.kind === 'audio_normalize') return ['input']
  return []
}

function utilityOutputValue(nodeId: string) {
  return `utility:${nodeId}`
}

function utilityInputValue(node: WorkflowUtilityNodeDraft, portId: string) {
  if (node.kind === 'audio_ensemble') {
    const index = Number(portId.split(':')[1])
    const inputs = Array.isArray(node.data.inputs) ? node.data.inputs : []
    return String(inputs[index] || '')
  }
  if (node.kind === 'audio_invert_phase' || node.kind === 'audio_normalize') {
    return String(node.data.input || '')
  }
  return ''
}

function utilityInputLabel(node: WorkflowUtilityNodeDraft, portId: string) {
  const value = utilityInputValue(node, portId)
  if (value) return formatConnectionValueLabel(value)
  if (node.kind === 'audio_ensemble') {
    const index = Number(portId.split(':')[1])
    return `Input ${Number.isFinite(index) ? index + 1 : ''}`.trim()
  }
  return t('workflows.stepInput')
}

function utilityInputPortToken(nodeId: string, portId: string) {
  return `in:utility:${nodeId}:${portId}`
}

function utilityOutputPortToken(nodeId: string) {
  return `out:utility:${nodeId}`
}

function utilityInputPort(node: WorkflowUtilityNodeDraft, portId: string): GraphPoint | null {
  const measured = measuredPort(utilityInputPortToken(node.id, portId))
  if (measured) return measured
  const position = nodePosition(node.id)
  if (node.kind === 'audio_ensemble') {
    const index = Number(portId.split(':')[1])
    return { x: position.x, y: position.y + 112 + Math.max(0, index) * 38 }
  }
  return { x: position.x, y: position.y + 112 }
}

function utilityOutputPort(node: WorkflowUtilityNodeDraft): GraphPoint | null {
  const measured = measuredPort(utilityOutputPortToken(node.id))
  if (measured) return measured
  const position = nodePosition(node.id)
  const y = node.kind === 'load_audio_batch'
    ? position.y + 148
    : (node.kind === 'audio_ensemble'
      ? position.y + utilityNodeHeight(node) - 28
      : position.y + 148)
  return { x: position.x + utilityNodeWidth(node.kind), y }
}

const graphConnections = computed<GraphConnection[]>(() => {
  const connections: GraphConnection[] = []
  steps.value.forEach((step, index) => {
    const source = outputPortForValue(step.input)
    const target = stepInputPort(index)
    if (!source || !target) return
    connections.push({
      id: `input-${step.id}`,
      path: connectionPath(source, target),
      className: 'workflow-edge workflow-edge--input',
      kind: 'step-input',
      stepId: step.id,
    })
  })
  utilityNodes.value.forEach((node) => {
    utilityInputPortIds(node).forEach((portId) => {
      const value = utilityInputValue(node, portId)
      const source = outputPortForValue(value)
      const target = utilityInputPort(node, portId)
      if (!source || !target) return
      connections.push({
        id: `utility-${node.id}-${portId}`,
        path: connectionPath(source, target),
        className: 'workflow-edge workflow-edge--input',
        kind: 'utility-input',
        utilityId: node.id,
        utilityPortId: portId,
      })
    })
  })
  saveOutputs.value.forEach((item, index) => {
    const source = outputPortForValue(item.source)
    const target = saveInputPort(index)
    if (!source || !target) return
    connections.push({
      id: `save-${item.key}`,
      path: connectionPath(source, target),
      className: 'workflow-edge workflow-edge--save',
      kind: 'save',
    })
  })
  if (pendingConnection.value && canvasMouseWorld.value) {
    const source = outputPortForValue(pendingConnection.value.value)
    if (source) {
      const pendingTarget = pendingConnectionTarget.value
      connections.push({
        id: 'pending',
        path: connectionPath(source, pendingTarget?.point || canvasMouseWorld.value),
        className: 'workflow-edge workflow-edge--pending',
        kind: 'pending',
      })
    }
  }
  return connections
})
const pendingConnectionTarget = computed<{ kind: 'step' | 'utility'; stepId?: string; utilityId?: string; utilityPortId?: string; point: GraphPoint } | null>(() => {
  if (!pendingConnection.value || !canvasMouseWorld.value) return null
  const threshold = 32 / Math.max(viewport.value.k, 0.35)
  let bestTarget: { kind: 'step' | 'utility'; stepId?: string; utilityId?: string; utilityPortId?: string; point: GraphPoint } | null = null
  let bestPoint: GraphPoint | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  steps.value.forEach((step, index) => {
    const point = stepInputPort(index)
    const dx = point.x - canvasMouseWorld.value!.x
    const dy = point.y - canvasMouseWorld.value!.y
    const distance = Math.sqrt(dx * dx + dy * dy)
    if (distance > threshold) return
    if (distance < bestDistance) {
      bestTarget = { kind: 'step', stepId: step.id, point }
      bestPoint = point
      bestDistance = distance
    }
  })
  utilityNodes.value.forEach((node) => {
    utilityInputPortIds(node).forEach((portId) => {
      const point = utilityInputPort(node, portId)
      if (!point) return
      const dx = point.x - canvasMouseWorld.value!.x
      const dy = point.y - canvasMouseWorld.value!.y
      const distance = Math.sqrt(dx * dx + dy * dy)
      if (distance > threshold) return
      if (distance < bestDistance) {
        bestTarget = { kind: 'utility', utilityId: node.id, utilityPortId: portId, point }
        bestPoint = point
        bestDistance = distance
      }
    })
  })
  return bestTarget && bestPoint ? bestTarget : null
})
const minimapViewportRect = computed(() => {
  const scale = viewport.value.k || 1
  return {
    x: -viewport.value.x / scale,
    y: -viewport.value.y / scale,
    width: viewportMetrics.value.width / scale,
    height: viewportMetrics.value.height / scale,
  }
})

function currentDefinitionSnapshot() {
  return serializeWorkflowGraphDefinition(graphDefinition.value)
}

function historyContentJsonFromJson(json: string) {
  try {
    const definition = readWorkflowGraphDefinition(JSON.parse(json) as Record<string, unknown>)
    const normalized = serializeWorkflowGraphDefinition({
      ...definition,
      graph: {
        ...definition.graph,
        viewport: { x: 0, y: 0, k: 1 },
      },
    })
    return JSON.stringify(normalized)
  } catch {
    return json
  }
}

function resetHistoryBaseline(json = JSON.stringify(serializeWorkflowGraphDefinition(graphDefinition.value))) {
  if (historyGroupTimer) {
    clearTimeout(historyGroupTimer)
    historyGroupTimer = null
  }
  historyGrouping = false
  currentHistoryJson = json
  currentHistoryContentJson = historyContentJsonFromJson(json)
  undoStack.value = []
  redoStack.value = []
}

function pushUndoSnapshot(json: string) {
  if (undoStack.value[undoStack.value.length - 1] === json) return
  undoStack.value = [...undoStack.value, json].slice(-HISTORY_LIMIT)
}

function recordHistoryTransition(json: string) {
  const contentJson = historyContentJsonFromJson(json)
  if (!historyReady || contentJson === currentHistoryContentJson) {
    currentHistoryJson = json
    currentHistoryContentJson = contentJson
    return
  }
  if (!historyGrouping) {
    pushUndoSnapshot(currentHistoryJson)
    historyGrouping = true
  }
  redoStack.value = []
  currentHistoryJson = json
  currentHistoryContentJson = contentJson
  if (historyGroupTimer) clearTimeout(historyGroupTimer)
  historyGroupTimer = setTimeout(() => {
    historyGroupTimer = null
    historyGrouping = false
  }, HISTORY_GROUP_DELAY)
}

function finishHistoryGroup() {
  if (historyGroupTimer) {
    clearTimeout(historyGroupTimer)
    historyGroupTimer = null
  }
  historyGrouping = false
}

function applyHistoryJson(json: string) {
  finishHistoryGroup()
  lastSyncedDefinitionJson = json
  currentHistoryJson = json
  currentHistoryContentJson = historyContentJsonFromJson(json)
  const parsed = JSON.parse(json) as Record<string, unknown>
  graphDefinition.value = readWorkflowGraphDefinition(parsed)
  definition.value = parsed
  cancelGraphConnection()
  closeContextMenu()
  paletteOpen.value = false
  schedulePortMeasure()
}

function undoGraphChange() {
  if (!canUndo.value) return false
  const previous = undoStack.value[undoStack.value.length - 1]
  undoStack.value = undoStack.value.slice(0, -1)
  redoStack.value = [...redoStack.value, currentHistoryJson].slice(-HISTORY_LIMIT)
  applyHistoryJson(previous)
  return true
}

function redoGraphChange() {
  if (!canRedo.value) return false
  const next = redoStack.value[redoStack.value.length - 1]
  redoStack.value = redoStack.value.slice(0, -1)
  pushUndoSnapshot(currentHistoryJson)
  applyHistoryJson(next)
  return true
}

watch(() => JSON.stringify(serializeWorkflowGraphDefinition(readWorkflowGraphDefinition(definition.value || {}))), (json) => {
  if (json === lastSyncedDefinitionJson) return
  lastSyncedDefinitionJson = json
  resetHistoryBaseline(json)
  graphDefinition.value = readWorkflowGraphDefinition(JSON.parse(json) as Record<string, unknown>)
}, { immediate: false })

watch(() => JSON.stringify(serializeWorkflowGraphDefinition(graphDefinition.value)), (json) => {
  if (json === lastSyncedDefinitionJson) return
  recordHistoryTransition(json)
  lastSyncedDefinitionJson = json
  definition.value = JSON.parse(json) as Record<string, unknown>
}, { flush: 'sync' })

watch(selectedGraphNode, (key) => {
  if (!key) {
    selectedGraphNodes.value = []
    return
  }
  if (!selectedGraphNodes.value.length || !selectedGraphNodes.value.includes(key)) {
    selectedGraphNodes.value = [key]
  }
})

function bindPendingConnectionPointerUp() {
  unbindPendingConnectionPointerUp()
  window.addEventListener('pointermove', handlePendingConnectionPointerMove)
  window.addEventListener('pointerup', handlePendingConnectionPointerUp)
}

function unbindPendingConnectionPointerUp() {
  window.removeEventListener('pointermove', handlePendingConnectionPointerMove)
  window.removeEventListener('pointerup', handlePendingConnectionPointerUp)
}

watch(() => steps.value.map(step => step.id).join('|'), () => {
  const items = steps.value
  if (!items.length) {
    mutateDraft((next) => {
      next.steps = [createStepDraft()]
      next.ui = createDefaultWorkflowNodeEditorUi(next.steps)
    })
    selectedGraphNode.value = stepSelectionKey(hydrateWorkflowDefinition(serializeWorkflowGraphDefinition(graphDefinition.value)).steps[0].id)
    return
  }
  ensureUiState()
  schedulePortMeasure()
  if (selectedGraphStepId.value && !items.some(step => step.id === selectedGraphStepId.value)) {
    selectedGraphNode.value = items[items.length - 1] ? stepSelectionKey(items[items.length - 1].id) : 'input'
  }
}, { immediate: true })

watch(() => steps.value.map(step => `${step.id}:${step.model}:${step.input}:${step.stems.join(',')}:${isStepCollapsed(step.id) ? '1' : '0'}`).join('|'), schedulePortMeasure, { flush: 'post' })
watch(() => graphDefinition.value.graph.nodes.map(node => `${node.id}:${node.position.x}:${node.position.y}`), schedulePortMeasure, { deep: true, flush: 'post' })
watch(() => `${viewport.value.x}:${viewport.value.y}:${viewport.value.k}`, schedulePortMeasure, { flush: 'post' })
watch(notes, () => {
  if (selectedGraphNoteId.value && !notes.value.some(note => note.id === selectedGraphNoteId.value)) {
    selectedGraphNode.value = 'input'
  }
}, { deep: true })
watch(utilityNodes, () => {
  if (selectedGraphUtilityId.value && !utilityNodes.value.some(node => node.id === selectedGraphUtilityId.value)) {
    selectedGraphNode.value = 'input'
  }
  if (utilityConfigModalId.value && !utilityNodes.value.some(node => node.id === utilityConfigModalId.value)) {
    utilityConfigModalId.value = ''
  }
}, { deep: true, immediate: true })
watch(
  () => batchInputNodes.value.map((node) => {
    const folder = String(node.data.folder || '').trim()
    const recursive = Boolean(node.data.recursive)
    const sortFiles = node.data.sortFiles === undefined ? true : Boolean(node.data.sortFiles)
    return `${node.id}|${folder}|${recursive ? '1' : '0'}|${sortFiles ? '1' : '0'}`
  }).join('||'),
  () => {
    scheduleBatchInputNodeTaskCountsRefresh()
  },
  { immediate: true },
)
watch(
  [
    utilityConfigNodeId,
    utilityConfigKind,
    () => String(utilityConfigData.value.folder || ''),
    () => Boolean(utilityConfigData.value.recursive),
    () => utilityConfigData.value.sortFiles === undefined ? true : Boolean(utilityConfigData.value.sortFiles),
  ],
  () => {
    if (!utilityConfigNode.value || utilityConfigKind.value !== 'load_audio_batch') {
      resetUtilityBatchPreview()
      return
    }
    scheduleUtilityBatchPreview()
  },
  { flush: 'post' },
)
watch(() => steps.value.map(step => step.id).join('|'), () => {
  if (stepConfigModalStepId.value && !steps.value.some(step => step.id === stepConfigModalStepId.value)) {
    stepConfigModalStepId.value = ''
  }
})

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('keyup', handleGlobalKeyup)
  window.addEventListener('blur', cleanupPointerInteraction)
  window.addEventListener('resize', refreshViewportMetrics)
  window.addEventListener('mousedown', handleWindowPointerDown)
  ensureUiState()
  schedulePortMeasure()
  void nextTick(async () => {
    await fitView()
    resetHistoryBaseline()
    historyReady = true
  })
})

onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame)
  if (measureFrame) cancelAnimationFrame(measureFrame)
  if (utilityBatchPreviewTimer) clearTimeout(utilityBatchPreviewTimer)
  if (batchInputNodeCountTimer) clearTimeout(batchInputNodeCountTimer)
  if (historyGroupTimer) clearTimeout(historyGroupTimer)
  document.removeEventListener('pointermove', handleGlobalPointerMove, true)
  document.removeEventListener('pointerup', handleGlobalPointerUp, true)
  window.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('keyup', handleGlobalKeyup)
  window.removeEventListener('blur', cleanupPointerInteraction)
  window.removeEventListener('resize', refreshViewportMetrics)
  window.removeEventListener('mousedown', handleWindowPointerDown)
  unbindPendingConnectionPointerUp()
})

function fallbackNodePosition(key: string): WorkflowCanvasPoint {
  if (key === 'input') return { x: GRAPH_INPUT_X, y: GRAPH_TOP_Y + 92 }
  if (key === 'save') return { x: saveNodeX.value, y: GRAPH_TOP_Y + 74 }
  const index = steps.value.findIndex(step => step.id === key)
  return {
    x: GRAPH_STEP_START_X + Math.max(0, index) * GRAPH_STEP_GAP,
    y: GRAPH_TOP_Y + (Math.max(0, index) % 2) * 96,
  }
}

function ensureUiState() {
  mutateDraft((next) => {
    next.saveTargets = Array.isArray(next.saveTargets)
      ? next.saveTargets
        .map(item => ({
          source: String(item.source || '').trim(),
          outputDir: String(item.outputDir || '').trim(),
        }))
        .filter(item => item.source.startsWith('utility:'))
      : []
    next.utilityNodes = Array.isArray(next.utilityNodes)
      ? next.utilityNodes.map((node) => ({
          ...node,
          x: Math.round(Number(node.x) || 0),
          y: Math.round(Number(node.y) || 0),
          data: (() => {
            const data = typeof node.data === 'object' && node.data ? { ...node.data } : {}
            if (node.kind === 'audio_ensemble') {
              const inputCount = Math.max(2, Math.min(10, Number(data.inputCount) || 2))
              const weights = Array.isArray(data.weights) ? [...data.weights] : []
              const inputs = Array.isArray(data.inputs) ? [...data.inputs] : []
              while (weights.length < inputCount) weights.push(1)
              while (inputs.length < inputCount) inputs.push('')
              return {
                ...data,
                inputCount,
                weights: weights.slice(0, inputCount),
                inputs: inputs.slice(0, inputCount),
              }
            }
            if (node.kind === 'audio_invert_phase' || node.kind === 'audio_normalize') {
              return {
                ...data,
                input: String(data.input || ''),
              }
            }
            return data
          })(),
        }))
      : []
    if (!next.ui) next.ui = createDefaultWorkflowNodeEditorUi(next.steps)
    ensureWorkflowStepIds(next.steps)
    next.ui.viewport = {
      x: Number.isFinite(next.ui.viewport?.x) ? next.ui.viewport.x : 0,
      y: Number.isFinite(next.ui.viewport?.y) ? next.ui.viewport.y : 0,
      k: clampZoom(Number.isFinite(next.ui.viewport?.k) ? next.ui.viewport.k : 1),
    }
    const nextNodes: Record<string, WorkflowCanvasPoint> = {}
    ;['input', ...next.steps.map(step => step.id), 'save'].forEach((key) => {
      nextNodes[key] = next.ui.nodes?.[key] || fallbackNodePosition(key)
    })
    next.ui.nodes = nextNodes
    next.ui.notes = Array.isArray(next.ui.notes)
      ? next.ui.notes.map(note => ({
          ...note,
          x: Math.round(Number(note.x) || 0),
          y: Math.round(Number(note.y) || 0),
          title: String(note.title || ''),
          content: String(note.content || ''),
          color: String(note.color || 'amber'),
        }))
      : []
    next.ui.collapsedStepIds = (next.ui.collapsedStepIds || [])
      .map(item => String(item || '').trim())
      .filter(item => item && next.steps.some(step => step.id === item))
  })
}

function stepDisplayId(index: number) {
  return getWorkflowStepDisplayId(index)
}

function isStepCollapsed(stepId: string) {
  return collapsedStepIds.value.includes(stepId)
}

function toggleStepCollapsed(stepId: string) {
  mutateDraft((next) => {
    if (next.ui.collapsedStepIds.includes(stepId)) {
      next.ui.collapsedStepIds = next.ui.collapsedStepIds.filter(id => id !== stepId)
      return
    }
    next.ui.collapsedStepIds = [...next.ui.collapsedStepIds, stepId]
  })
}

function openStepConfig(stepId: string) {
  stepConfigModalStepId.value = stepId
  selectedGraphNode.value = stepSelectionKey(stepId)
}

function closeStepConfig() {
  stepConfigModalStepId.value = ''
}

function openSaveConfig() {
  saveConfigOpen.value = true
  selectedGraphNode.value = 'save'
}

function closeSaveConfig() {
  saveConfigOpen.value = false
}

function stepDisplayIdByStep(step: WorkflowStepDraft) {
  const index = steps.value.findIndex(item => item.id === step.id)
  return index >= 0 ? stepDisplayId(index) : step.id
}

function stepStemValue(step: WorkflowStepDraft, stem: string) {
  return `${step.id}.${stem}`
}

function stepStemLabelByIndex(index: number, stem: string) {
  return `${stepDisplayId(index)}.${stem}`
}

function stepSelectionKey(stepId: string) {
  return `step:${stepId}`
}

function noteSelectionKey(noteId: string) {
  return `note:${noteId}`
}

function utilitySelectionKey(nodeId: string) {
  return `utility:${nodeId}`
}

function nodePosition(key: string): WorkflowCanvasPoint {
  const graphNode = graphNodeById(key)
  if (graphNode) return graphNode.position
  return editorUi.value.nodes?.[key] || fallbackNodePosition(key)
}

function updateGraphNodePosition(nodeId: string, point: WorkflowCanvasPoint) {
  const x = Math.round(point.x)
  const y = Math.round(point.y)
  if (!graphDefinition.value.graph.nodes.some(node => node.id === nodeId)) return false
  graphDefinition.value = {
    ...graphDefinition.value,
    graph: {
      ...graphDefinition.value.graph,
      nodes: graphDefinition.value.graph.nodes.map(node => node.id === nodeId
        ? { ...node, position: { x, y } }
        : node),
    },
  }
  schedulePortMeasure()
  return true
}

function setNodePosition(key: string, point: WorkflowCanvasPoint) {
  if (updateGraphNodePosition(key, point)) return
  mutateDraft((next) => {
    next.ui.nodes = {
      ...next.ui.nodes,
      [key]: {
        x: Math.round(point.x),
        y: Math.round(point.y),
      },
    }
  })
  schedulePortMeasure()
}

function updateNotePosition(id: string, point: WorkflowCanvasPoint) {
  if (updateGraphNodePosition(id, point)) return
  mutateDraft((next) => {
    next.ui.notes = next.ui.notes.map(note => note.id === id
      ? { ...note, x: Math.round(point.x), y: Math.round(point.y) }
      : note)
  })
  schedulePortMeasure()
}

function stepNodeHeight(step: WorkflowStepDraft) {
  if (isStepCollapsed(step.id)) return 168
  return 168 + Math.max(1, step.stems.length) * 26
}

function saveNodeHeight() {
  return Math.min(332, 124 + Math.max(1, saveOutputs.value.length) * 38)
}

function inputNodeHeight() {
  return 120
}

function noteHeight(note: WorkflowNoteDraft) {
  // minHeight only: the inline textarea autosizes and grows the card naturally,
  // so the resting size just tracks content instead of forcing extra height.
  const lines = `${note.title}\n${note.content}`.split(/\r?\n/).filter(Boolean).length
  return Math.max(NOTE_MIN_HEIGHT, Math.min(NOTE_MAX_HEIGHT, 56 + lines * 18))
}

function utilityNodeWidth(kind: WorkflowUtilityNodeKind) {
  return kind === 'audio_ensemble' ? 268 : 236
}

function utilityNodeHeight(node: WorkflowUtilityNodeDraft) {
  if (node.kind === 'audio_ensemble') {
    const count = Math.max(2, Math.min(10, Number(node.data.inputCount) || 2))
    return 182 + count * 42
  }
  if (node.kind === 'load_audio_batch') return 176
  return 176
}

function utilityNodeStyle(node: WorkflowUtilityNodeDraft) {
  const position = nodePosition(node.id)
  return {
    left: `${position.x - canvasBounds.value.minX}px`,
    top: `${position.y - canvasBounds.value.minY}px`,
    width: `${utilityNodeWidth(node.kind)}px`,
    minHeight: `${utilityNodeHeight(node)}px`,
  }
}

function utilityNodeTitle(kind: WorkflowUtilityNodeKind) {
  if (kind === 'load_audio_batch') return t('workflows.batchInputNode')
  if (kind === 'audio_ensemble') return t('workflows.audioEnsembleNode')
  if (kind === 'audio_invert_phase') return t('workflows.invertPhaseNode')
  return t('workflows.audioNormalizeNode')
}

function utilityNodeDisplayLabel(node: WorkflowUtilityNodeDraft) {
  const index = utilityNodes.value.findIndex(item => item.id === node.id)
  return index >= 0 ? `${utilityNodeTitle(node.kind)} ${index + 1}` : utilityNodeTitle(node.kind)
}

function utilityNodeDefaultOutputDir(node: WorkflowUtilityNodeDraft) {
  const label = utilityNodeDisplayLabel(node)
  return label.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').trim() || 'utility_output'
}

function utilityNodeSummary(node: WorkflowUtilityNodeDraft) {
  if (node.kind === 'load_audio_batch') {
    return String(node.data.folder || '').trim() || t('workflows.batchInputFolderPlaceholder')
  }
  if (node.kind === 'audio_ensemble') {
    return `${t('workflows.ensembleType')}: ${String(node.data.ensembleType || 'avg_wave')}`
  }
  if (node.kind === 'audio_invert_phase') return t('workflows.invertPhaseSummary')
  return t('workflows.audioNormalizeSummary')
}

function utilityNodeMeta(node: WorkflowUtilityNodeDraft) {
  if (node.kind === 'load_audio_batch') {
    return [
      `${t('workflows.recursive')}: ${Boolean(node.data.recursive) ? '✓' : '—'}`,
      `${t('workflows.sortFiles')}: ${node.data.sortFiles === undefined ? '✓' : (Boolean(node.data.sortFiles) ? '✓' : '—')}`,
    ].join(' · ')
  }
  if (node.kind === 'audio_ensemble') {
    return `${t('workflows.inputCount')}: ${Math.max(2, Math.min(10, Number(node.data.inputCount) || 2))}`
  }
  return t('workflows.frontendOnlyNode')
}

function utilityNodeWarning(node: WorkflowUtilityNodeDraft) {
  const missingInputs = getWorkflowUtilityNodeInputMissingCount(node)
  if (missingInputs > 0) return t('workflows.utilityInputsRequired', { count: missingInputs })
  if (node.kind === 'load_audio_batch' && !String(node.data.folder || '').trim()) return t('workflows.batchInputFolderRequired')
  return ''
}

function utilityNodeTaskCountLabel(node: WorkflowUtilityNodeDraft) {
  if (node.kind !== 'load_audio_batch') return ''
  const count = batchInputNodeTaskCounts.value[node.id]
  if (typeof count !== 'number') return ''
  return t('workflows.batchInputEstimatedTasks', { count })
}

function baseName(path: string) {
  return path.split(/[/\\]/).filter(Boolean).pop() || path
}

function graphNodeStyle(key: string, extra: Record<string, string> = {}) {
  const position = nodePosition(key)
  return {
    left: `${position.x - canvasBounds.value.minX}px`,
    top: `${position.y - canvasBounds.value.minY}px`,
    width: `${GRAPH_NODE_WIDTH}px`,
    ...extra,
  }
}

function noteNodeStyle(note: WorkflowNoteDraft) {
  return {
    left: `${note.x - canvasBounds.value.minX}px`,
    top: `${note.y - canvasBounds.value.minY}px`,
    width: `${NOTE_WIDTH}px`,
    minHeight: `${noteHeight(note)}px`,
  }
}

function noteColorClass(color: string) {
  return `graph-note--${['amber', 'blue', 'green', 'rose'].includes(color) ? color : 'amber'}`
}

function connectionPath(source: GraphPoint, target: GraphPoint) {
  const dx = Math.max(80, Math.abs(target.x - source.x) * 0.42)
  return `M ${source.x} ${source.y} C ${source.x + dx} ${source.y}, ${target.x - dx} ${target.y}, ${target.x} ${target.y}`
}

function shiftedConnectionPath(path: string) {
  let isX = true
  const { minX, minY } = canvasBounds.value
  return path.replace(/-?\d+(?:\.\d+)?/g, (value) => {
    const shifted = Number(value) - (isX ? minX : minY)
    isX = !isX
    return String(Math.round(shifted * 100) / 100)
  })
}

function measuredPort(id: string): GraphPoint | null {
  return portPositions.value[id] || null
}

function schedulePortMeasure() {
  if (measureFrame) return
  measureFrame = requestAnimationFrame(() => {
    measureFrame = 0
    measurePorts()
  })
}

function refreshViewportMetrics() {
  const rect = canvasViewportRef.value?.getBoundingClientRect()
  if (!rect) return
  viewportMetrics.value = {
    width: Math.max(1, rect.width),
    height: Math.max(1, rect.height),
  }
}

function measurePorts() {
  const viewport = canvasViewportRef.value
  if (!viewport) return
  refreshViewportMetrics()
  const next: Record<string, GraphPoint> = {}
  viewport.querySelectorAll<HTMLElement>('[data-port-id]').forEach((element) => {
    const id = element.dataset.portId
    if (!id) return
    const rect = element.getBoundingClientRect()
    const point = screenToWorld(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (point) next[id] = point
  })
  portPositions.value = next
}

function stepInputPort(index: number): GraphPoint {
  const step = steps.value[index]
  const position = nodePosition(step?.id || `step_${index + 1}`)
  return measuredPort(`in:${step?.id}`) || { x: position.x, y: position.y + 76 }
}

function stepStemPort(index: number, stem: string): GraphPoint | null {
  const step = steps.value[index]
  if (!step) return null
  const measured = measuredPort(`out:${step.id}.${stem}`)
  if (measured) return measured
  const position = nodePosition(step.id)
  const stemIndex = Math.max(0, step.stems.findIndex(item => item === stem))
  return { x: position.x + GRAPH_NODE_WIDTH, y: position.y + 132 + stemIndex * 26 }
}

function saveInputPort(index: number): GraphPoint {
  const measured = measuredPort(`in:save:${index}`)
  if (measured) return measured
  const position = nodePosition('save')
  return { x: position.x, y: position.y + 96 + index * 24 }
}

function outputPortForValue(value: string): GraphPoint | null {
  if (!value) return null
  if (value === 'input') {
    const measured = measuredPort('out:input')
    if (measured) return measured
    const position = nodePosition('input')
    return { x: position.x + GRAPH_NODE_WIDTH, y: position.y + 78 }
  }
  if (value.startsWith('utility:')) {
    const utilityId = value.slice('utility:'.length).trim()
    const utilityNode = utilityNodes.value.find(node => node.id === utilityId)
    return utilityNode ? utilityOutputPort(utilityNode) : null
  }
  const [stepId, stem] = value.split('.', 2)
  const stepIndex = steps.value.findIndex(step => step.id === stepId)
  if (stepIndex < 0 || !stem) return null
  return stepStemPort(stepIndex, stem)
}

function inputValueIsInvalid(value: string) {
  const raw = String(value || '').trim()
  if (!raw || raw === 'input') return false
  if (raw.startsWith('utility:')) {
    const utilityId = raw.slice('utility:'.length).trim()
    return !utilityNodes.value.some(node => node.id === utilityId)
  }
  const [stepId, stem] = raw.split('.', 2)
  const step = steps.value.find(item => item.id === stepId)
  return !step || !stem || !step.stems.some(item => item.toLowerCase() === stem.toLowerCase())
}

function validationTargetForFirstBatchInputNode() {
  return batchInputNodes.value[0] ? utilitySelectionKey(batchInputNodes.value[0].id) : 'input'
}

function validationTargetForFirstMissingBatchInputNode() {
  const node = batchInputNodes.value.find(item => !String(item.data.folder || '').trim())
  return node ? utilitySelectionKey(node.id) : validationTargetForFirstBatchInputNode()
}

function validationTargetForFirstMissingUtilityInput() {
  const node = utilityNodes.value.find(item => getWorkflowUtilityNodeInputMissingCount(item) > 0)
  return node ? utilitySelectionKey(node.id) : 'input'
}

function validationTargetForFirstDanglingConnection() {
  const nodeIds = new Set(graphDefinition.value.graph.nodes.map(node => node.id))
  const edge = graphDefinition.value.graph.edges.find(item => !nodeIds.has(item.source.nodeId) || !nodeIds.has(item.target.nodeId))
  return edge ? selectionKeyForGraphNodeId(nodeIds.has(edge.target.nodeId) ? edge.target.nodeId : edge.source.nodeId) : 'input'
}

function validationTargetForFirstDuplicateInputConnection() {
  const counts = new Map<string, number>()
  for (const edge of graphDefinition.value.graph.edges) {
    const key = `${edge.target.nodeId}:${edge.target.portId}`
    const count = (counts.get(key) || 0) + 1
    if (count > 1) return selectionKeyForGraphNodeId(edge.target.nodeId)
    counts.set(key, count)
  }
  return 'input'
}

function validationTargetForFirstInvalidConnection() {
  const invalidStep = steps.value.find(step => inputValueIsInvalid(step.input))
  if (invalidStep) return stepSelectionKey(invalidStep.id)
  const invalidUtility = utilityNodes.value.find((node) => {
    if (node.kind === 'audio_ensemble') {
      return (Array.isArray(node.data.inputs) ? node.data.inputs : []).some(value => inputValueIsInvalid(String(value || '')))
    }
    if (node.kind === 'audio_invert_phase' || node.kind === 'audio_normalize') return inputValueIsInvalid(String(node.data.input || ''))
    return false
  })
  return invalidUtility ? utilitySelectionKey(invalidUtility.id) : 'input'
}

function validationTargetForExecutableNode() {
  if (steps.value[0]) return stepSelectionKey(steps.value[0].id)
  if (utilityNodes.value[0]) return utilitySelectionKey(utilityNodes.value[0].id)
  return 'input'
}

function formatConnectionValueLabel(value: string) {
  if (!value) return ''
  if (value === 'input') return t('workflows.originalInput')
  if (value.startsWith('utility:')) {
    const utilityId = value.slice('utility:'.length).trim()
    const utilityNode = utilityNodes.value.find(node => node.id === utilityId)
    return utilityNode ? utilityNodeDisplayLabel(utilityNode) : value
  }
  const [stepId, stem] = value.split('.', 2)
  if (!stem) return value
  const stepIndex = steps.value.findIndex(step => step.id === stepId)
  return stepIndex >= 0 ? stepStemLabelByIndex(stepIndex, stem) : value
}

function inputOptions(index: number) {
  const options = [{ label: t('workflows.originalInput'), value: 'input' }]
  utilityNodes.value.forEach((node) => {
    options.push({
      label: utilityNodeDisplayLabel(node),
      value: utilityOutputValue(node.id),
    })
  })
  steps.value.slice(0, index).forEach((step, stepIndex) => {
    step.stems.forEach((stem) => {
      options.push({ label: stepStemLabelByIndex(stepIndex, stem), value: stepStemValue(step, stem) })
    })
  })
  return options
}

function modelStemOptions(modelName: string) {
  const entry = props.models.find(item => item.name === modelName)
  return parseModelStems(entry?.configInstruments || entry?.configTargetInstrument || entry?.targetStem)
    .map(stem => ({ label: stem, value: stem }))
}

function selectGraphNode(key: string, options?: { append?: boolean; toggle?: boolean }) {
  const append = Boolean(options?.append)
  const toggle = Boolean(options?.toggle)
  if (!append && !toggle) {
    selectedGraphNode.value = key
    selectedGraphNodes.value = [key]
    return
  }
  const current = [...selectedGraphNodes.value]
  const exists = current.includes(key)
  if (toggle) {
    const next = exists ? current.filter(item => item !== key) : [...current, key]
    selectedGraphNodes.value = next.length ? next : [key]
    selectedGraphNode.value = selectedGraphNodes.value[selectedGraphNodes.value.length - 1] || key
    return
  }
  selectedGraphNodes.value = exists ? current : [...current, key]
  selectedGraphNode.value = key
}

function selectionKeyForGraphNodeId(nodeId: string) {
  if (!nodeId || nodeId === 'input' || nodeId === 'save') return nodeId || 'input'
  if (steps.value.some(step => step.id === nodeId)) return stepSelectionKey(nodeId)
  if (utilityNodes.value.some(node => node.id === nodeId)) return utilitySelectionKey(nodeId)
  if (notes.value.some(note => note.id === nodeId)) return noteSelectionKey(nodeId)
  return 'input'
}

function focusGraphSelectionKey(key: string) {
  const targetKey = key || 'input'
  selectGraphNode(targetKey)
  const bounds = nodeBoundsBySelectionKey(targetKey)
  if (!bounds) return
  const scale = viewport.value.k || 1
  viewport.value = {
    ...viewport.value,
    x: Math.round(viewportMetrics.value.width / 2 - (bounds.x + bounds.width / 2) * scale),
    y: Math.round(viewportMetrics.value.height / 2 - (bounds.y + bounds.height / 2) * scale),
  }
}

function focusValidationIssue(issue: WorkflowValidationIssue) {
  focusGraphSelectionKey(issue.targetKey || 'input')
}

function isGraphNodeSelected(key: string) {
  return selectedGraphNodes.value.includes(key)
}

function clearGraphSelection(next = 'input') {
  selectedGraphNode.value = next
  selectedGraphNodes.value = [next]
}

function graphSelectionKeysForDrag(key: string) {
  return isGraphNodeSelected(key) ? [...selectedGraphNodes.value] : [key]
}

function movableSelectionKeys() {
  return [...selectedGraphNodes.value].filter(key => key === 'input' || key === 'save' || key.startsWith('step:') || key.startsWith('utility:') || key.startsWith('note:'))
}

function duplicableSelectionKeys() {
  return [...selectedGraphNodes.value].filter(key => key.startsWith('step:') || key.startsWith('utility:') || key.startsWith('note:'))
}

function removableSelectionKeys() {
  return [...selectedGraphNodes.value].filter((key) => {
    if (key.startsWith('step:')) return steps.value.length > 1
    return key.startsWith('utility:') || key.startsWith('note:')
  })
}

function selectionKeyFromEventTarget(target: HTMLElement | null) {
  return target?.closest<HTMLElement>('[data-selection-key]')?.dataset.selectionKey || ''
}

function selectAllGraphNodes() {
  const keys = ['input', ...steps.value.map(step => stepSelectionKey(step.id)), ...utilityNodes.value.map(node => utilitySelectionKey(node.id)), 'save', ...notes.value.map(note => noteSelectionKey(note.id))]
  selectedGraphNodes.value = keys
  selectedGraphNode.value = keys[keys.length - 1] || 'input'
}

function alignSelectedNodes(axis: 'x' | 'y') {
  const keys = movableSelectionKeys()
  if (keys.length < 2) return
  const points = keys.map(key => ({ key, point: nodeSelectionPoint(key) })).filter((item): item is { key: string; point: WorkflowCanvasPoint } => Boolean(item.point))
  if (points.length < 2) return
  const target = Math.min(...points.map(item => item.point[axis]))
  points.forEach(({ key, point }) => {
    setSelectionKeyPosition(key, axis === 'x' ? { x: target, y: point.y } : { x: point.x, y: target })
  })
}

function distributeSelectedNodes(axis: 'x' | 'y') {
  const keys = movableSelectionKeys()
  if (keys.length < 3) return
  const points = keys.map(key => ({ key, point: nodeSelectionPoint(key) })).filter((item): item is { key: string; point: WorkflowCanvasPoint } => Boolean(item.point)).sort((a, b) => a.point[axis] - b.point[axis])
  if (points.length < 3) return
  const start = points[0].point[axis]
  const end = points[points.length - 1].point[axis]
  const gap = (end - start) / (points.length - 1)
  points.forEach((item, index) => {
    const value = Math.round(start + gap * index)
    setSelectionKeyPosition(item.key, axis === 'x' ? { x: value, y: item.point.y } : { x: item.point.x, y: value })
  })
}

function dependencyValueIdsForUtilityNode(node: WorkflowUtilityNodeDraft) {
  if (node.kind === 'audio_ensemble') {
    return (Array.isArray(node.data.inputs) ? node.data.inputs : [])
      .map(value => String(value || '').trim())
      .filter(Boolean)
  }
  if (node.kind === 'audio_invert_phase' || node.kind === 'audio_normalize') {
    const value = String(node.data.input || '').trim()
    return value ? [value] : []
  }
  return []
}

function sourceNodeIdFromInputValue(value: string) {
  const raw = String(value || '').trim()
  if (!raw || raw === 'input') return 'input'
  if (raw.startsWith('utility:')) return raw.slice('utility:'.length).trim()
  const [stepId, stem] = raw.split('.', 2)
  return stepId && stem ? stepId : ''
}

function autoLayoutGraph() {
  const layoutIds = [...steps.value.map(step => step.id), ...utilityNodes.value.map(node => node.id)]
  const idSet = new Set(layoutIds)
  const memo = new Map<string, number>()
  const visiting = new Set<string>()
  const layerFor = (nodeId: string): number => {
    if (memo.has(nodeId)) return memo.get(nodeId) || 1
    if (visiting.has(nodeId)) return 1
    visiting.add(nodeId)
    const step = steps.value.find(item => item.id === nodeId)
    const utility = utilityNodes.value.find(item => item.id === nodeId)
    const inputs = step ? [step.input] : utility ? dependencyValueIdsForUtilityNode(utility) : []
    const dependencyLayers = inputs
      .map(sourceNodeIdFromInputValue)
      .filter(id => id && id !== 'input' && idSet.has(id))
      .map(layerFor)
    const layer = dependencyLayers.length ? Math.max(...dependencyLayers) + 1 : 1
    visiting.delete(nodeId)
    memo.set(nodeId, layer)
    return layer
  }
  const nodesByLayer = new Map<number, string[]>()
  layoutIds.forEach((nodeId) => {
    const layer = layerFor(nodeId)
    nodesByLayer.set(layer, [...(nodesByLayer.get(layer) || []), nodeId])
  })
  const sortedLayers = [...nodesByLayer.keys()].sort((a, b) => a - b)
  const nextPositions = new Map<string, WorkflowCanvasPoint>()
  nextPositions.set('input', { x: GRAPH_INPUT_X, y: 220 })
  sortedLayers.forEach((layer) => {
    const ids = [...(nodesByLayer.get(layer) || [])].sort((a, b) => nodePosition(a).y - nodePosition(b).y || a.localeCompare(b))
    let y = GRAPH_TOP_Y
    ids.forEach((nodeId) => {
      nextPositions.set(nodeId, { x: GRAPH_STEP_START_X + (layer - 1) * GRAPH_STEP_GAP, y })
      const step = steps.value.find(item => item.id === nodeId)
      const utility = utilityNodes.value.find(item => item.id === nodeId)
      y += (step ? stepNodeHeight(step) : utility ? utilityNodeHeight(utility) : 168) + 44
    })
  })
  const maxLayer = sortedLayers.length ? Math.max(...sortedLayers) : 1
  nextPositions.set('save', { x: GRAPH_STEP_START_X + maxLayer * GRAPH_STEP_GAP + GRAPH_SAVE_GAP, y: 220 })
  mutateDraft((next) => {
    next.ui.nodes = {
      ...next.ui.nodes,
      input: nextPositions.get('input')!,
      save: nextPositions.get('save')!,
      ...Object.fromEntries(next.steps.map(step => [step.id, nextPositions.get(step.id) || next.ui.nodes[step.id] || fallbackNodePosition(step.id)])),
    }
    next.utilityNodes = next.utilityNodes.map(node => ({
      ...node,
      ...(nextPositions.get(node.id) || { x: node.x, y: node.y }),
    }))
  })
  clearGraphSelection(selectedGraphNode.value || 'input')
  void nextTick(() => fitView())
}

function nodeSelectionPoint(key: string): WorkflowCanvasPoint | null {
  if (key.startsWith('note:')) {
    const noteId = key.slice('note:'.length)
    const note = notes.value.find(item => item.id === noteId)
    return note ? { x: note.x, y: note.y } : null
  }
  const nodeKey = key.startsWith('step:')
    ? key.slice('step:'.length)
    : key.startsWith('utility:')
      ? key.slice('utility:'.length)
      : key
  return { ...nodePosition(nodeKey) }
}

function setSelectionKeyPosition(key: string, point: WorkflowCanvasPoint) {
  if (key.startsWith('note:')) {
    updateNotePosition(key.slice('note:'.length), point)
    return
  }
  const nodeKey = key.startsWith('step:')
    ? key.slice('step:'.length)
    : key.startsWith('utility:')
      ? key.slice('utility:'.length)
      : key
  setNodePosition(nodeKey, point)
}

function nodeBoundsBySelectionKey(key: string) {
  if (key === 'input') return { x: nodePosition('input').x, y: nodePosition('input').y, width: GRAPH_NODE_WIDTH, height: inputNodeHeight() }
  if (key === 'save') return { x: nodePosition('save').x, y: nodePosition('save').y, width: GRAPH_NODE_WIDTH, height: saveNodeHeight() }
  if (key.startsWith('step:')) {
    const stepId = key.slice('step:'.length)
    const step = steps.value.find(item => item.id === stepId)
    if (!step) return null
    return { x: nodePosition(stepId).x, y: nodePosition(stepId).y, width: GRAPH_NODE_WIDTH, height: stepNodeHeight(step) }
  }
  if (key.startsWith('utility:')) {
    const utilityId = key.slice('utility:'.length)
    const node = utilityNodes.value.find(item => item.id === utilityId)
    if (!node) return null
    return { x: nodePosition(utilityId).x, y: nodePosition(utilityId).y, width: utilityNodeWidth(node.kind), height: utilityNodeHeight(node) }
  }
  if (key.startsWith('note:')) {
    const noteId = key.slice('note:'.length)
    const note = notes.value.find(item => item.id === noteId)
    if (!note) return null
    return { x: note.x, y: note.y, width: NOTE_WIDTH, height: noteHeight(note) }
  }
  return null
}

function applyMarqueeSelection(start: WorkflowCanvasPoint, end: WorkflowCanvasPoint) {
  const minX = Math.min(start.x, end.x)
  const maxX = Math.max(start.x, end.x)
  const minY = Math.min(start.y, end.y)
  const maxY = Math.max(start.y, end.y)
  const keys = ['input', ...steps.value.map(step => stepSelectionKey(step.id)), ...utilityNodes.value.map(node => utilitySelectionKey(node.id)), 'save', ...notes.value.map(note => noteSelectionKey(note.id))]
  const selected = keys.filter((key) => {
    const bounds = nodeBoundsBySelectionKey(key)
    if (!bounds) return false
    return bounds.x < maxX && bounds.x + bounds.width > minX && bounds.y < maxY && bounds.y + bounds.height > minY
  })
  if (selected.length) {
    selectedGraphNodes.value = selected
    selectedGraphNode.value = selected[selected.length - 1]
    return
  }
  clearGraphSelection('input')
}

function selectedMovableNodeKey() {
  if (selectedGraphNode.value === 'input' || selectedGraphNode.value === 'save') return selectedGraphNode.value
  if (selectedGraphStepId.value) return selectedGraphStepId.value
  if (selectedGraphUtilityId.value) return selectedGraphUtilityId.value
  return ''
}

function nudgeSelectedGraphNode(dx: number, dy: number) {
  const selectionKeys = movableSelectionKeys()
  if (selectionKeys.length > 1) {
    selectionKeys.forEach((key) => {
      const point = nodeSelectionPoint(key)
      if (!point) return
      setSelectionKeyPosition(key, {
        x: point.x + dx,
        y: point.y + dy,
      })
    })
    return true
  }
  if (selectedGraphNote.value) {
    updateNotePosition(selectedGraphNote.value.id, {
      x: selectedGraphNote.value.x + dx,
      y: selectedGraphNote.value.y + dy,
    })
    return true
  }
  const key = selectedMovableNodeKey()
  if (!key) return false
  const point = nodePosition(key)
  setNodePosition(key, {
    x: point.x + dx,
    y: point.y + dy,
  })
  return true
}

function duplicateSelectedGraphNode() {
  const keys = duplicableSelectionKeys()
  if (!keys.length) return false
  const createdKeys: string[] = []
  keys.forEach((key) => {
    if (key.startsWith('step:')) {
      const step = steps.value.find(item => item.id === key.slice('step:'.length))
      const createdKey = step ? duplicateGraphStep(step) : ''
      if (createdKey) createdKeys.push(createdKey)
      return
    }
    if (key.startsWith('note:')) {
      const createdKey = duplicateGraphNote(key.slice('note:'.length))
      if (createdKey) createdKeys.push(createdKey)
      return
    }
    if (key.startsWith('utility:')) {
      const createdKey = duplicateUtilityNode(key.slice('utility:'.length))
      if (createdKey) createdKeys.push(createdKey)
    }
  })
  if (createdKeys.length) {
    selectedGraphNodes.value = createdKeys
    selectedGraphNode.value = createdKeys[createdKeys.length - 1]
    return true
  }
  return false
}

function copySelectedGraphNodes() {
  const keys = duplicableSelectionKeys()
  if (!keys.length) return false
  graphClipboard.value = {
    steps: keys
      .filter(key => key.startsWith('step:'))
      .map((key) => {
        const stepId = key.slice('step:'.length)
        const step = steps.value.find(item => item.id === stepId)
        return step ? { step: JSON.parse(JSON.stringify(step)) as WorkflowStepDraft, position: { ...nodePosition(step.id) } } : null
      })
      .filter((item): item is { step: WorkflowStepDraft; position: WorkflowCanvasPoint } => Boolean(item)),
    utilities: keys
      .filter(key => key.startsWith('utility:'))
      .map((key) => {
        const node = utilityNodes.value.find(item => item.id === key.slice('utility:'.length))
        return node ? { node: JSON.parse(JSON.stringify(node)) as WorkflowUtilityNodeDraft } : null
      })
      .filter((item): item is { node: WorkflowUtilityNodeDraft } => Boolean(item)),
    notes: keys
      .filter(key => key.startsWith('note:'))
      .map(key => notes.value.find(item => item.id === key.slice('note:'.length)))
      .filter((item): item is WorkflowNoteDraft => Boolean(item))
      .map(note => JSON.parse(JSON.stringify(note)) as WorkflowNoteDraft),
  }
  clipboardPasteCount = 0
  return canPasteGraphNodes.value
}

function rewriteCopiedInputValue(value: unknown, idMap: Map<string, string>) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.startsWith('utility:')) {
    const sourceId = raw.slice('utility:'.length).trim()
    const mapped = idMap.get(sourceId)
    return mapped ? utilityOutputValue(mapped) : raw
  }
  const [sourceId, stem] = raw.split('.', 2)
  const mapped = idMap.get(sourceId)
  return mapped && stem ? `${mapped}.${stem}` : raw
}

function pasteGraphNodes() {
  const clip = graphClipboard.value
  if (!clip || (!clip.steps.length && !clip.utilities.length && !clip.notes.length)) return false
  clipboardPasteCount += 1
  const offset = 72 * clipboardPasteCount
  const idMap = new Map<string, string>()
  const createdKeys: string[] = []
  mutateDraft((next) => {
    const copiedSteps = clip.steps.map(({ step, position }) => {
      const copy: WorkflowStepDraft = {
        ...createStepDraft(next.steps.length),
        model: step.model,
        input: step.input,
        stems: [...step.stems],
        save: { ...step.save },
        overlapSize: step.overlapSize,
        modelKind: step.modelKind,
        customModelType: step.customModelType,
      }
      idMap.set(step.id, copy.id)
      next.ui.nodes[copy.id] = { x: Math.round(position.x + offset), y: Math.round(position.y + offset) }
      createdKeys.push(stepSelectionKey(copy.id))
      return copy
    })
    const copiedUtilities = clip.utilities.map(({ node }) => {
      const copy = createWorkflowUtilityNodeDraft(node.kind, { x: node.x + offset, y: node.y + offset })
      copy.data = JSON.parse(JSON.stringify(node.data || {})) as Record<string, unknown>
      idMap.set(node.id, copy.id)
      createdKeys.push(utilitySelectionKey(copy.id))
      return copy
    })
    copiedSteps.forEach((step) => {
      step.input = rewriteCopiedInputValue(step.input, idMap)
    })
    copiedUtilities.forEach((node) => {
      if (node.kind === 'audio_ensemble') {
        const inputs = Array.isArray(node.data.inputs) ? [...node.data.inputs] : []
        node.data = {
          ...node.data,
          inputs: inputs.map(value => rewriteCopiedInputValue(value, idMap)),
        }
      } else if (node.kind === 'audio_invert_phase' || node.kind === 'audio_normalize') {
        node.data = {
          ...node.data,
          input: rewriteCopiedInputValue(node.data.input, idMap),
        }
      }
    })
    next.steps = [...next.steps, ...copiedSteps]
    next.utilityNodes = [...next.utilityNodes, ...copiedUtilities]
    clip.utilities.forEach(({ node }) => {
      const copiedId = idMap.get(node.id)
      if (!copiedId) return
      const sourceSaveTarget = next.saveTargets.find(target => target.source === utilityOutputValue(node.id))
      if (!sourceSaveTarget) return
      next.saveTargets = [
        ...next.saveTargets,
        { source: utilityOutputValue(copiedId), outputDir: sourceSaveTarget.outputDir },
      ]
    })
    next.ui.notes = [
      ...next.ui.notes,
      ...clip.notes.map((note) => {
        const copy = createWorkflowNoteDraft({ x: note.x + offset, y: note.y + offset })
        copy.title = note.title
        copy.content = note.content
        copy.color = note.color
        createdKeys.push(noteSelectionKey(copy.id))
        return copy
      }),
    ]
    ensureWorkflowStepIds(next.steps)
  })
  refreshSaveNodePosition()
  ensureUiState()
  if (createdKeys.length) {
    selectedGraphNodes.value = createdKeys
    selectedGraphNode.value = createdKeys[createdKeys.length - 1]
  }
  return true
}

function removeSelectedGraphNode() {
  const keys = removableSelectionKeys()
  if (!keys.length) return false
  keys.forEach((key) => {
    if (key.startsWith('step:')) {
      const step = steps.value.find(item => item.id === key.slice('step:'.length))
      if (step) removeGraphStep(step)
      return
    }
    if (key.startsWith('note:')) {
      removeGraphNote(key.slice('note:'.length))
      return
    }
    if (key.startsWith('utility:')) {
      removeUtilityNode(key.slice('utility:'.length))
    }
  })
  clearGraphSelection('input')
  return true
}

function openSelectedGraphNodeConfig() {
  if (selectedGraphStepId.value) {
    openStepConfig(selectedGraphStepId.value)
    return true
  }
  if (selectedGraphUtilityId.value) {
    openUtilityConfig(selectedGraphUtilityId.value)
    return true
  }
  if (selectedGraphNode.value === 'save') {
    openSaveConfig()
    return true
  }
  return false
}

function stepRenderKey(step: WorkflowStepDraft) {
  return step.id
}

function refreshSaveNodePosition() {
  const candidates = steps.value.map(step => nodePosition(step.id).x + GRAPH_SAVE_GAP)
  const fallbackX = saveNodeX.value
  const current = nodePosition('save')
  setNodePosition('save', {
    x: Math.max(fallbackX, ...candidates),
    y: current.y,
  })
}

function handleModelChange(step: WorkflowStepDraft) {
  mutateDraft((next) => {
    const target = next.steps.find(item => item.id === step.id)
    if (!target) return
    const options = modelStemOptions(target.model).map(item => item.value)
    target.stems = target.stems.filter(stem => options.includes(stem))
    target.save = Object.fromEntries(target.stems.map(stem => [stem, target.save?.[stem] || stem]))
    clearReferencesToUnavailableStepStems(next, target.id, target.stems)
  })
}

function clearReferencesToUnavailableStepStems(draft: WorkflowDefinitionDraft, stepId: string, availableStems: string[]) {
  const allowed = new Set(availableStems.map(stem => stem.toLowerCase()))
  const shouldClear = (value: unknown) => {
    const [sourceId, stem] = String(value || '').trim().split('.', 2)
    return Boolean(sourceId === stepId && stem && !allowed.has(stem.toLowerCase()))
  }
  draft.steps.forEach((step) => {
    if (shouldClear(step.input)) step.input = ''
  })
  draft.utilityNodes = draft.utilityNodes.map((node) => {
    if (node.kind === 'audio_ensemble') {
      const inputs = Array.isArray(node.data.inputs) ? [...node.data.inputs] : []
      return {
        ...node,
        data: {
          ...node.data,
          inputs: inputs.map(value => shouldClear(value) ? '' : value),
        },
      }
    }
    if (node.kind === 'audio_invert_phase' || node.kind === 'audio_normalize') {
      return shouldClear(node.data.input)
        ? { ...node, data: { ...node.data, input: '' } }
        : node
    }
    return node
  })
}

function updateStepModel(stepId: string, value: string) {
  mutateDraft((next) => {
    const target = next.steps.find(item => item.id === stepId)
    if (!target) return
    target.model = value
    const options = modelStemOptions(target.model).map(item => item.value)
    target.stems = target.stems.filter(stem => options.includes(stem))
    target.save = Object.fromEntries(target.stems.map(stem => [stem, target.save?.[stem] || stem]))
    clearReferencesToUnavailableStepStems(next, target.id, target.stems)
  })
}

function applyAllModelStems(step: WorkflowStepDraft) {
  mutateDraft((next) => {
    const target = next.steps.find(item => item.id === step.id)
    if (!target) return
    target.stems = modelStemOptions(target.model).map(item => item.value)
    target.save = Object.fromEntries(target.stems.map(stem => [stem, target.save?.[stem] || stem]))
    clearReferencesToUnavailableStepStems(next, target.id, target.stems)
  })
}

function updateStepStems(stepId: string, value: string[]) {
  mutateDraft((next) => {
    const target = next.steps.find(item => item.id === stepId)
    if (!target) return
    target.stems = [...value]
    target.save = Object.fromEntries(target.stems.map(stem => [stem, target.save?.[stem] || stem]))
    clearReferencesToUnavailableStepStems(next, target.id, target.stems)
  })
}

function clearStepStems(step: WorkflowStepDraft) {
  mutateDraft((next) => {
    const target = next.steps.find(item => item.id === step.id)
    if (!target) return
    target.stems = []
    target.save = {}
    clearReferencesToUnavailableStepStems(next, target.id, target.stems)
  })
}

function updateStepOverlap(stepId: string, value: number | null) {
  mutateDraft((next) => {
    const target = next.steps.find(item => item.id === stepId)
    if (!target) return
    target.overlapSize = value
  })
}

function resetStepInput(step: WorkflowStepDraft, index: number) {
  mutateDraft((next) => {
    const target = next.steps.find(item => item.id === step.id)
    if (!target) return
    target.input = inputOptions(index)[0]?.value || 'input'
  })
}

function updateSaveOutputDir(item: { type: 'step' | 'utility'; stepIndex?: number; stem?: string; utilityId?: string; source: string }, value: string | null) {
  if (item.type === 'step') {
    const step = typeof item.stepIndex === 'number' ? steps.value[item.stepIndex] : null
    if (!step || !item.stem) return
    const stem = item.stem
    mutateDraft((next) => {
      const target = next.steps.find(item2 => item2.id === step.id)
      if (!target) return
      target.save = {
        ...target.save,
        [stem]: value?.trim() || stem,
      }
    })
    return
  }
  if (item.type === 'utility' && item.utilityId) {
    const utilityNode = utilityNodes.value.find(node => node.id === item.utilityId)
    mutateDraft((next) => {
      const outputDir = value?.trim() || (utilityNode ? utilityNodeDefaultOutputDir(utilityNode) : 'utility_output')
      const existing = next.saveTargets.filter(target => target.source !== item.source)
      next.saveTargets = [...existing, { source: item.source, outputDir }]
    })
  }
}

function beginGraphConnection(value: string, label: string) {
  pendingConnection.value = { value, label }
  closeContextMenu()
  bindPendingConnectionPointerUp()
}

function connectGraphInput(index: number) {
  const step = steps.value[index]
  if (!step) return
  if (!pendingConnection.value) {
    selectGraphNode(stepSelectionKey(step.id))
    return
  }
  mutateDraft((next) => {
    const target = next.steps.find(item => item.id === step.id)
    if (!target) return
    target.input = pendingConnection.value?.value || ''
  })
  cancelGraphConnection()
  selectGraphNode(stepSelectionKey(step.id))
}

// Resolve the node id that a connection value (`input` / `stepId.stem` /
// `utility:id`) originates from. Returns '' for the primary input node.
function connectionValueNodeId(value: string): string {
  const raw = String(value || '').trim()
  if (!raw || raw === 'input') return ''
  if (raw.startsWith('utility:')) return raw.slice('utility:'.length)
  const dot = raw.indexOf('.')
  return dot > 0 ? raw.slice(0, dot) : raw
}

// Direct input references (upstream node ids) feeding a given node.
function nodeInputSourceIds(nodeId: string): string[] {
  const ids: string[] = []
  const step = steps.value.find(item => item.id === nodeId)
  if (step) {
    const id = connectionValueNodeId(String(step.input || ''))
    if (id) ids.push(id)
    return ids
  }
  const utility = utilityNodes.value.find(item => item.id === nodeId)
  if (utility) {
    utilityInputPortIds(utility).forEach((portId) => {
      const id = connectionValueNodeId(utilityInputValue(utility, portId))
      if (id) ids.push(id)
    })
  }
  return ids
}

// Would linking pendingConnection (source) into targetNodeId form a cycle?
// A cycle exists iff the source node already (transitively) depends on target.
function wouldPendingConnectionCreateCycle(targetNodeId: string): boolean {
  const sourceId = connectionValueNodeId(pendingConnection.value?.value || '')
  if (!sourceId) return false
  if (sourceId === targetNodeId) return true
  const visited = new Set<string>()
  const stack = [sourceId]
  while (stack.length) {
    const current = stack.pop()!
    if (current === targetNodeId) return true
    if (visited.has(current)) continue
    visited.add(current)
    nodeInputSourceIds(current).forEach(id => stack.push(id))
  }
  return false
}

function connectPendingToStep(stepId: string) {
  const index = steps.value.findIndex(step => step.id === stepId)
  if (index < 0 || !pendingConnection.value) return false
  if (wouldPendingConnectionCreateCycle(stepId)) {
    message.warning(t('workflows.connectionCycleBlocked'))
    return false
  }
  mutateDraft((next) => {
    const target = next.steps.find(item => item.id === stepId)
    if (!target) return
    target.input = pendingConnection.value?.value || ''
  })
  cancelGraphConnection()
  selectGraphNode(stepSelectionKey(stepId))
  return true
}

function connectUtilityInput(nodeId: string, portId: string) {
  const node = utilityNodes.value.find(item => item.id === nodeId)
  if (!node) return
  if (!pendingConnection.value) {
    selectGraphNode(utilitySelectionKey(nodeId))
    return
  }
  if (wouldPendingConnectionCreateCycle(nodeId)) {
    message.warning(t('workflows.connectionCycleBlocked'))
    return
  }
  mutateDraft((next) => {
    next.utilityNodes = next.utilityNodes.map((item) => {
      if (item.id !== nodeId) return item
      if (item.kind === 'audio_ensemble') {
        const index = Number(portId.split(':')[1])
        const inputs = Array.isArray(item.data.inputs) ? [...item.data.inputs] : Array.from({ length: Math.max(2, Math.min(10, Number(item.data.inputCount) || 2)) }, () => '')
        inputs[index] = pendingConnection.value?.value || ''
        return {
          ...item,
          data: {
            ...item.data,
            inputs,
          },
        }
      }
      return {
        ...item,
        data: {
          ...item.data,
          input: pendingConnection.value?.value || '',
        },
      }
    })
  })
  cancelGraphConnection()
  selectGraphNode(utilitySelectionKey(nodeId))
}

function connectPendingToUtility(nodeId: string, portId: string) {
  if (!pendingConnection.value) return false
  connectUtilityInput(nodeId, portId)
  return true
}

function isPendingTargetStep(stepId: string) {
  return pendingConnectionTarget.value?.kind === 'step' && pendingConnectionTarget.value?.stepId === stepId
}

function isPendingTargetUtility(nodeId: string, portId: string) {
  return pendingConnectionTarget.value?.kind === 'utility'
    && pendingConnectionTarget.value?.utilityId === nodeId
    && pendingConnectionTarget.value?.utilityPortId === portId
}

function disconnectGraphInput(index: number) {
  const step = steps.value[index]
  if (!step) return
  mutateDraft((next) => {
    const target = next.steps.find(item => item.id === step.id)
    if (!target) return
    target.input = ''
  })
  selectGraphNode(stepSelectionKey(step.id))
}

function disconnectUtilityInput(nodeId: string, portId: string) {
  mutateDraft((next) => {
    next.utilityNodes = next.utilityNodes.map((node) => {
      if (node.id !== nodeId) return node
      if (node.kind === 'audio_ensemble') {
        const index = Number(portId.split(':')[1])
        const inputs = Array.isArray(node.data.inputs) ? [...node.data.inputs] : []
        if (index >= 0 && index < inputs.length) inputs[index] = ''
        return {
          ...node,
          data: {
            ...node.data,
            inputs,
          },
        }
      }
      return {
        ...node,
        data: {
          ...node.data,
          input: '',
        },
      }
    })
  })
  selectGraphNode(utilitySelectionKey(nodeId))
}

function handleEdgeClick(edge: GraphConnection) {
  if (edge.kind === 'step-input' && edge.stepId) {
    const index = steps.value.findIndex(step => step.id === edge.stepId)
    if (index >= 0) disconnectGraphInput(index)
    hoveredEdgeId.value = ''
    return
  }
  if (edge.kind === 'utility-input' && edge.utilityId && edge.utilityPortId) {
    disconnectUtilityInput(edge.utilityId, edge.utilityPortId)
    hoveredEdgeId.value = ''
  }
}

function cancelGraphConnection() {
  pendingConnection.value = null
  unbindPendingConnectionPointerUp()
}

function addGraphStepAt(point?: WorkflowCanvasPoint, forcedInput?: string) {
  let createdId = ''
  mutateDraft((next) => {
    const draft = createStepDraft(next.steps.length)
    draft.input = forcedInput || inputOptions(next.steps.length)[0]?.value || 'input'
    next.steps.push(draft)
    ensureWorkflowStepIds(next.steps)
    createdId = draft.id
    const previousStep = next.steps[next.steps.length - 2]
    const base = point || (previousStep
      ? { x: nodePosition(previousStep.id).x + GRAPH_STEP_GAP, y: nodePosition(previousStep.id).y + (next.steps.length % 2 ? 96 : -96) }
      : fallbackNodePosition(draft.id))
    next.ui.nodes = {
      ...next.ui.nodes,
      [draft.id]: { x: Math.round(base.x), y: Math.round(base.y) },
    }
  })
  refreshSaveNodePosition()
  ensureUiState()
  if (createdId) selectedGraphNode.value = stepSelectionKey(createdId)
  if (forcedInput) cancelGraphConnection()
}

function addGraphStep() {
  addGraphStepAt()
}

function removeGraphStep(target: number | WorkflowStepDraft) {
  const step = typeof target === 'number' ? steps.value[target] : target
  const index = step ? steps.value.findIndex(item => item.id === step.id) : -1
  if (index < 0 || steps.value.length <= 1) return
  const removedId = step.id
  const nextSelection = steps.value[index + 1] || steps.value[index - 1] || null
  mutateDraft((next) => {
    const nextNodes = { ...next.ui.nodes }
    delete nextNodes[removedId]
    next.steps.splice(index, 1)
    ensureWorkflowStepIds(next.steps)
    next.steps.forEach((item) => {
      const [sourceId, stem] = item.input.split('.', 2)
      if (stem && sourceId === removedId) item.input = ''
    })
    next.utilityNodes = next.utilityNodes.map((node) => {
      if (node.kind === 'audio_ensemble') {
        const inputs = Array.isArray(node.data.inputs) ? [...node.data.inputs] : []
        return {
          ...node,
          data: {
            ...node.data,
            inputs: inputs.map((value) => {
              const [sourceId, stem] = String(value || '').split('.', 2)
              return stem && sourceId === removedId ? '' : value
            }),
          },
        }
      }
      if (node.kind === 'audio_invert_phase' || node.kind === 'audio_normalize') {
        const [sourceId, stem] = String(node.data.input || '').split('.', 2)
        return stem && sourceId === removedId
          ? { ...node, data: { ...node.data, input: '' } }
          : node
      }
      return node
    })
    next.ui.nodes = {
      input: nodePosition('input'),
      save: nodePosition('save'),
      ...Object.fromEntries(next.steps.map(item => [item.id, nextNodes[item.id] || fallbackNodePosition(item.id)])),
    }
    next.ui.collapsedStepIds = next.ui.collapsedStepIds.filter(id => id !== removedId)
  })
  refreshSaveNodePosition()
  selectedGraphNode.value = nextSelection ? stepSelectionKey(nextSelection.id) : 'input'
}

function duplicateGraphStep(target: number | WorkflowStepDraft) {
  const source = typeof target === 'number' ? steps.value[target] : target
  if (!source) return ''
  const index = steps.value.findIndex(item => item.id === source.id)
  if (index < 0) return ''
  const sourcePosition = nodePosition(source.id)
  let createdId = ''
  mutateDraft((next) => {
    const draft: WorkflowStepDraft = {
      ...createStepDraft(next.steps.length),
      model: source.model,
      input: source.input,
      stems: [...source.stems],
      save: { ...source.save },
      overlapSize: source.overlapSize,
      modelKind: source.modelKind,
      customModelType: source.customModelType,
    }
    next.steps.splice(index + 1, 0, draft)
    ensureWorkflowStepIds(next.steps)
    createdId = draft.id
    next.ui.nodes = {
      ...next.ui.nodes,
      [draft.id]: { x: sourcePosition.x + 64, y: sourcePosition.y + 64 },
    }
  })
  refreshSaveNodePosition()
  if (createdId) {
    selectedGraphNode.value = stepSelectionKey(createdId)
    return stepSelectionKey(createdId)
  }
  return ''
}

function addGraphNote(point?: WorkflowCanvasPoint) {
  const note = createWorkflowNoteDraft(point || canvasCenterWorldPoint())
  mutateDraft((next) => {
    next.ui.notes = [...next.ui.notes, note]
  })
  selectedGraphNode.value = noteSelectionKey(note.id)
}

function duplicateGraphNote(id: string) {
  const note = notes.value.find(item => item.id === id)
  if (!note) return ''
  const copy = {
    ...createWorkflowNoteDraft({ x: note.x + 56, y: note.y + 56 }),
    title: note.title,
    content: note.content,
    color: note.color,
  }
  mutateDraft((next) => {
    next.ui.notes = [...next.ui.notes, copy]
  })
  selectedGraphNode.value = noteSelectionKey(copy.id)
  return noteSelectionKey(copy.id)
}

function addUtilityNode(kind: WorkflowUtilityNodeKind, point?: WorkflowCanvasPoint) {
  const node = createWorkflowUtilityNodeDraft(kind, point || canvasCenterWorldPoint())
  mutateDraft((next) => {
    next.utilityNodes = [...next.utilityNodes, node]
  })
  selectedGraphNode.value = utilitySelectionKey(node.id)
}

function duplicateUtilityNode(id: string) {
  const source = utilityNodes.value.find(node => node.id === id)
  if (!source) return ''
  const copy = createWorkflowUtilityNodeDraft(source.kind, { x: source.x + 56, y: source.y + 56 })
  copy.data = JSON.parse(JSON.stringify(source.data || {})) as Record<string, unknown>
  mutateDraft((next) => {
    next.utilityNodes = [...next.utilityNodes, copy]
    const sourceSaveTarget = next.saveTargets.find(target => target.source === utilityOutputValue(id))
    if (sourceSaveTarget) {
      next.saveTargets = [
        ...next.saveTargets,
        {
          source: utilityOutputValue(copy.id),
          outputDir: sourceSaveTarget.outputDir,
        },
      ]
    }
  })
  selectedGraphNode.value = utilitySelectionKey(copy.id)
  return utilitySelectionKey(copy.id)
}

function resetUtilityBatchPreview() {
  utilityBatchPreviewToken += 1
  utilityBatchPreview.value = null
  utilityBatchPreviewLoading.value = false
  utilityBatchPreviewError.value = ''
}
function scheduleBatchInputNodeTaskCountsRefresh() {
  if (batchInputNodeCountTimer) clearTimeout(batchInputNodeCountTimer)
  batchInputNodeCountTimer = setTimeout(() => {
    batchInputNodeCountTimer = null
    refreshBatchInputNodeTaskCounts()
  }, 180)
}

function refreshBatchInputNodeTaskCounts() {
  const nodes = batchInputNodes.value
  const next: Record<string, number | null> = {}
  nodes.forEach((node) => {
    next[node.id] = null
  })
  batchInputNodeTaskCounts.value = next
  if (!nodes.length) return
  const token = ++batchInputNodeCountToken
  nodes.forEach((node) => {
    const folder = String(node.data.folder || '').trim()
    if (!folder) return
    void invoke<ScanAudioPathsResult>('scan_audio_paths_with_options', {
      paths: [folder],
      recursive: Boolean(node.data.recursive),
      sortFiles: node.data.sortFiles === undefined ? true : Boolean(node.data.sortFiles),
    }).then((result) => {
      if (token !== batchInputNodeCountToken) return
      batchInputNodeTaskCounts.value = {
        ...batchInputNodeTaskCounts.value,
        [node.id]: result.files.length,
      }
    }).catch(() => {
      if (token !== batchInputNodeCountToken) return
      batchInputNodeTaskCounts.value = {
        ...batchInputNodeTaskCounts.value,
        [node.id]: null,
      }
    })
  })
}

async function refreshUtilityBatchPreview() {
  if (utilityConfigKind.value !== 'load_audio_batch') {
    resetUtilityBatchPreview()
    return
  }
  const folder = String(utilityConfigData.value.folder || '').trim()
  if (!folder) {
    resetUtilityBatchPreview()
    return
  }
  const requestToken = ++utilityBatchPreviewToken
  utilityBatchPreviewLoading.value = true
  utilityBatchPreviewError.value = ''
  try {
    const result = await invoke<ScanAudioPathsResult>('scan_audio_paths_with_options', {
      paths: [folder],
      recursive: Boolean(utilityConfigData.value.recursive),
      sortFiles: utilityConfigData.value.sortFiles === undefined ? true : Boolean(utilityConfigData.value.sortFiles),
    })
    if (requestToken !== utilityBatchPreviewToken) return
    utilityBatchPreview.value = result
  } catch (error) {
    if (requestToken !== utilityBatchPreviewToken) return
    utilityBatchPreview.value = null
    utilityBatchPreviewError.value = error instanceof Error ? error.message : String(error || '')
  } finally {
    if (requestToken === utilityBatchPreviewToken) {
      utilityBatchPreviewLoading.value = false
    }
  }
}

function scheduleUtilityBatchPreview() {
  if (utilityBatchPreviewTimer) clearTimeout(utilityBatchPreviewTimer)
  utilityBatchPreviewTimer = setTimeout(() => {
    utilityBatchPreviewTimer = null
    void refreshUtilityBatchPreview()
  }, 220)
}

async function browseUtilityBatchFolder() {
  try {
    const folder = await invoke<string | null>('pick_input_folder')
    if (!folder || !utilityConfigNodeId.value) return
    updateUtilityConfigData({ folder })
  } catch (error) {
    utilityBatchPreviewError.value = error instanceof Error ? error.message : String(error || '')
  }
}

async function openUtilityBatchFolder() {
  const folder = String(utilityConfigData.value.folder || '').trim()
  if (!folder) return
  try {
    await invoke('reveal_path', { path: folder })
  } catch (error) {
    utilityBatchPreviewError.value = error instanceof Error ? error.message : String(error || '')
  }
}

function openUtilityConfig(id: string) {
  utilityConfigModalId.value = id
  selectedGraphNode.value = utilitySelectionKey(id)
  scheduleUtilityBatchPreview()
}

function closeUtilityConfig() {
  utilityConfigModalId.value = ''
  if (utilityBatchPreviewTimer) {
    clearTimeout(utilityBatchPreviewTimer)
    utilityBatchPreviewTimer = null
  }
}

function removeUtilityNode(id: string) {
  mutateDraft((next) => {
    next.saveTargets = next.saveTargets.filter(target => target.source !== utilityOutputValue(id))
    next.utilityNodes = next.utilityNodes.filter(node => node.id !== id)
    next.steps = next.steps.map((step) => ({
      ...step,
      input: step.input === utilityOutputValue(id) ? '' : step.input,
    }))
    next.utilityNodes = next.utilityNodes.map((node) => {
      if (node.kind === 'audio_ensemble') {
        const inputs = Array.isArray(node.data.inputs) ? [...node.data.inputs] : []
        return {
          ...node,
          data: {
            ...node.data,
            inputs: inputs.map(value => String(value || '') === utilityOutputValue(id) ? '' : value),
          },
        }
      }
      if (node.kind === 'audio_invert_phase' || node.kind === 'audio_normalize') {
        return {
          ...node,
          data: {
            ...node.data,
            input: String(node.data.input || '') === utilityOutputValue(id) ? '' : node.data.input,
          },
        }
      }
      return node
    })
  })
  if (selectedGraphNode.value === utilitySelectionKey(id)) {
    selectedGraphNode.value = 'input'
  }
  if (utilityConfigModalId.value === id) {
    utilityConfigModalId.value = ''
  }
}

function updateUtilityNodeData(id: string, patch: Record<string, unknown>) {
  mutateDraft((next) => {
    next.utilityNodes = next.utilityNodes.map(node => {
      if (node.id !== id) return node
      return {
        ...node,
        data: {
          ...node.data,
          ...patch,
        },
      }
    })
  })
}

function updateUtilityWeights(id: string, index: number, value: number | null) {
  const target = utilityNodes.value.find(node => node.id === id)
  if (!target) return
  const inputCount = Math.max(2, Math.min(10, Number(target.data.inputCount) || 2))
  const weights = Array.isArray(target.data.weights) ? [...target.data.weights] : Array.from({ length: inputCount }, () => 1)
  while (weights.length < inputCount) weights.push(1)
  weights[index] = value == null ? 1 : value
  updateUtilityNodeData(id, { weights })
}

function updateUtilityInputCount(id: string, value: number | null) {
  const inputCount = Math.max(2, Math.min(10, value == null ? 2 : value))
  const target = utilityNodes.value.find(node => node.id === id)
  const current = Array.isArray(target?.data.weights) ? [...target!.data.weights] : []
  const inputs = Array.isArray(target?.data.inputs) ? [...target!.data.inputs] : []
  while (current.length < inputCount) current.push(1)
  while (inputs.length < inputCount) inputs.push('')
  updateUtilityNodeData(id, {
    inputCount,
    weights: current.slice(0, inputCount),
    inputs: inputs.slice(0, inputCount),
  })
}

function updateUtilityConfigData(patch: Record<string, unknown>) {
  if (!utilityConfigNodeId.value) return
  updateUtilityNodeData(utilityConfigNodeId.value, patch)
}

function updateUtilityConfigInputCount(value: number | null) {
  if (!utilityConfigNodeId.value) return
  updateUtilityInputCount(utilityConfigNodeId.value, value)
}

function updateUtilityConfigWeight(index: number, value: number | null) {
  if (!utilityConfigNodeId.value) return
  updateUtilityWeights(utilityConfigNodeId.value, index, value)
}

function removeGraphNote(id: string) {
  if (graphNodeById(id)) {
    graphDefinition.value = {
      ...graphDefinition.value,
      graph: {
        ...graphDefinition.value.graph,
        nodes: graphDefinition.value.graph.nodes.filter(node => node.id !== id),
        edges: graphDefinition.value.graph.edges.filter(edge => edge.source.nodeId !== id && edge.target.nodeId !== id),
      },
    }
  } else {
    mutateDraft((next) => {
      next.ui.notes = next.ui.notes.filter(note => note.id !== id)
    })
  }
  if (selectedGraphNode.value === noteSelectionKey(id)) {
    selectedGraphNode.value = 'input'
  }
}

function updateSelectedNote(patch: Partial<WorkflowNoteDraft>) {
  if (!selectedGraphNote.value) return
  const noteId = selectedGraphNote.value.id
  if (graphNodeById(noteId)) {
    graphDefinition.value = {
      ...graphDefinition.value,
      graph: {
        ...graphDefinition.value.graph,
        nodes: graphDefinition.value.graph.nodes.map(node => node.id === noteId
          ? {
              ...node,
              position: {
                x: Math.round(patch.x ?? node.position.x),
                y: Math.round(patch.y ?? node.position.y),
              },
              data: {
                ...node.data,
                ...(patch.title !== undefined ? { title: patch.title } : {}),
                ...(patch.content !== undefined ? { content: patch.content } : {}),
                ...(patch.color !== undefined ? { color: patch.color } : {}),
                ...(patch.fontSize !== undefined ? { fontSize: patch.fontSize } : {}),
                ...(patch.fontFamily !== undefined ? { fontFamily: patch.fontFamily } : {}),
              },
            }
          : node),
      },
    }
    return
  }
  mutateDraft((next) => {
    next.ui.notes = next.ui.notes.map(note => note.id === noteId
      ? { ...note, ...patch }
      : note)
  })
}

function isEditingNoteField(noteId: string, field: 'title' | 'content') {
  return editingNoteField.value?.noteId === noteId && editingNoteField.value?.field === field
}

function beginNoteEdit(noteId: string, field: 'title' | 'content') {
  selectGraphNode(noteSelectionKey(noteId))
  editingNoteField.value = { noteId, field }
  void nextTick(() => {
    const ref = noteEditInputRef.value
    const el = Array.isArray(ref) ? ref[0] : ref
    if (!el) return
    el.focus()
    const length = el.value.length
    el.setSelectionRange?.(length, length)
    if (el instanceof HTMLTextAreaElement) autoGrowNoteInput(el)
  })
}

function autoGrowNoteInput(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

function onNoteContentInput(event: Event) {
  const el = event.target as HTMLTextAreaElement
  updateSelectedNote({ content: el.value })
  autoGrowNoteInput(el)
}

function finishNoteEdit() {
  editingNoteField.value = null
}

function canvasCenterWorldPoint() {
  const scale = viewport.value.k || 1
  return {
    x: (-viewport.value.x + viewportMetrics.value.width / 2) / scale,
    y: (-viewport.value.y + viewportMetrics.value.height / 2) / scale,
  }
}

function openPalette(point?: WorkflowCanvasPoint) {
  paletteInsertWorld.value = point || canvasCenterWorldPoint()
  paletteSearch.value = ''
  paletteOpen.value = true
}

function applyPaletteItem(kind: PaletteKind) {
  if (kind === 'step') {
    addGraphStepAt(paletteInsertWorld.value || undefined)
  } else if (kind === 'note') {
    addGraphNote(paletteInsertWorld.value || undefined)
  } else {
    addUtilityNode(kind, paletteInsertWorld.value || undefined)
  }
  paletteOpen.value = false
}

function openContextMenu(event: MouseEvent, mode: 'add' | 'selection' = 'add') {
  const rect = canvasViewportRef.value?.getBoundingClientRect()
  if (!rect) return
  const world = screenToWorld(event.clientX, event.clientY)
  if (!world) return
  contextMenu.value = {
    show: true,
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
    world,
    mode,
  }
}

function closeContextMenu() {
  if (!contextMenu.value.show) return
  contextMenu.value = { show: false, x: 0, y: 0, world: null, mode: 'add' }
}

function handleWindowPointerDown(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (!target?.closest('.node-context-menu')) closeContextMenu()
  if ((event.ctrlKey || event.metaKey || event.shiftKey) || event.button !== 0) return
  if (target?.closest('.graph-node, .graph-note, .canvas-floating, .node-context-menu')) return
  if (target?.closest('.node-canvas-wrap')) clearGraphSelection('input')
}

function handleCanvasContextMenu(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, [contenteditable="true"], .n-input, .n-base-selection')) {
    closeContextMenu()
    return
  }
  event.preventDefault()
  if (pendingConnection.value) {
    cancelGraphConnection()
    return
  }
  if (target?.closest('.canvas-floating, .node-context-menu')) {
    closeContextMenu()
    return
  }
  const selectionKey = selectionKeyFromEventTarget(target)
  if (selectionKey) {
    if (!isGraphNodeSelected(selectionKey)) selectGraphNode(selectionKey)
    openContextMenu(event, 'selection')
    return
  }
  if (hasMultipleSelection.value) {
    openContextMenu(event, 'selection')
    return
  }
  openContextMenu(event, 'add')
}

function handleGlobalKeyup(event: KeyboardEvent) {
  if (event.code === 'Space') {
    spacePanning.value = false
  }
}

function handleGlobalKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    if (pendingConnection.value) {
      event.preventDefault()
      cancelGraphConnection()
      return
    }
    if (contextMenu.value.show) {
      event.preventDefault()
      closeContextMenu()
      return
    }
    if (paletteOpen.value) {
      event.preventDefault()
      paletteOpen.value = false
      return
    }
    if (selectedGraphNodes.value.length > 1) {
      event.preventDefault()
      clearGraphSelection(selectedGraphNode.value || 'input')
      return
    }
  }
  if (event.code === 'Space') {
    const target = event.target as HTMLElement | null
    if (!target?.closest('input, textarea, [role="combobox"]')) {
      spacePanning.value = true
      event.preventDefault()
    }
    return
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    if (event.key.toLowerCase() === 'z') {
      if (event.shiftKey ? redoGraphChange() : undoGraphChange()) {
        event.preventDefault()
      }
      return
    }
    if (event.key.toLowerCase() === 'y') {
      if (redoGraphChange()) {
        event.preventDefault()
      }
      return
    }
    if (event.key.toLowerCase() === 'c') {
      const target = event.target as HTMLElement | null
      if (!target?.closest('input, textarea, [role="combobox"]') && copySelectedGraphNodes()) {
        event.preventDefault()
      }
      return
    }
    if (event.key.toLowerCase() === 'v') {
      const target = event.target as HTMLElement | null
      if (!target?.closest('input, textarea, [role="combobox"]') && pasteGraphNodes()) {
        event.preventDefault()
      }
      return
    }
    if (event.key === '=' || event.key === '+') {
      event.preventDefault()
      zoomBy(ZOOM_STEP)
      return
    }
    if (event.key === '-') {
      event.preventDefault()
      zoomBy(1 / ZOOM_STEP)
      return
    }
    if (event.key === '0') {
      event.preventDefault()
      resetView()
      return
    }
    if (event.key.toLowerCase() === 'a') {
      const target = event.target as HTMLElement | null
      if (!target?.closest('input, textarea, [role="combobox"]')) {
        event.preventDefault()
        selectAllGraphNodes()
        return
      }
    }
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'f') {
    const target = event.target as HTMLElement | null
    if (!target?.closest('input, textarea, [role="combobox"]')) {
      event.preventDefault()
      void fitView()
      return
    }
  }
  if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea, [role=\"combobox\"]')) return
    event.preventDefault()
    openPalette(canvasMouseWorld.value || canvasCenterWorldPoint())
    return
  }
  const target = event.target as HTMLElement | null
  if (!target?.closest('input, textarea, [role="combobox"]')) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'd') {
      if (duplicateSelectedGraphNode()) {
        event.preventDefault()
        return
      }
    }
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === 'e') {
      if (openSelectedGraphNodeConfig()) {
        event.preventDefault()
        return
      }
    }
    if (event.key.startsWith('Arrow')) {
      const step = event.shiftKey ? 24 : 8
      const delta = event.key === 'ArrowLeft'
        ? { x: -step, y: 0 }
        : event.key === 'ArrowRight'
          ? { x: step, y: 0 }
          : event.key === 'ArrowUp'
            ? { x: 0, y: -step }
            : { x: 0, y: step }
      if (nudgeSelectedGraphNode(delta.x, delta.y)) {
        event.preventDefault()
        return
      }
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      if (removeSelectedGraphNode()) {
        event.preventDefault()
      }
    }
  }
}

function clampZoom(value: number) {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
}

function screenToWorld(clientX: number, clientY: number): WorkflowCanvasPoint | null {
  const rect = canvasViewportRef.value?.getBoundingClientRect()
  if (!rect) return null
  return {
    x: (clientX - rect.left - viewport.value.x) / viewport.value.k,
    y: (clientY - rect.top - viewport.value.y) / viewport.value.k,
  }
}

function zoomAt(clientX: number, clientY: number, nextScale: number) {
  const rect = canvasViewportRef.value?.getBoundingClientRect()
  if (!rect) return
  const scale = clampZoom(nextScale)
  const mouseX = clientX - rect.left
  const mouseY = clientY - rect.top
  const worldX = (mouseX - viewport.value.x) / viewport.value.k
  const worldY = (mouseY - viewport.value.y) / viewport.value.k
  viewport.value = {
    x: Math.round(mouseX - worldX * scale),
    y: Math.round(mouseY - worldY * scale),
    k: scale,
  }
}

function zoomBy(factor: number) {
  const rect = canvasViewportRef.value?.getBoundingClientRect()
  if (!rect) return
  zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, viewport.value.k * factor)
}

function handleCanvasWheel(event: WheelEvent) {
  event.preventDefault()
  closeContextMenu()
  if (event.shiftKey) {
    viewport.value = {
      ...viewport.value,
      x: Math.round(viewport.value.x - event.deltaY * 0.7),
    }
    return
  }
  const factor = event.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP
  zoomAt(event.clientX, event.clientY, viewport.value.k * factor)
}

function handleCanvasPointerMove(event: PointerEvent) {
  canvasMouseWorld.value = screenToWorld(event.clientX, event.clientY)
}

function maybeCreateNodeFromPendingPointer(event: PointerEvent) {
  if (!pendingConnection.value) return false
  const target = event.target as HTMLElement | null
  if (target?.closest('.graph-node, .graph-note, .graph-port, .canvas-floating, .node-context-menu')) return false
  const world = screenToWorld(event.clientX, event.clientY)
  if (!world) return false
  addGraphStepAt(world, pendingConnection.value.value)
  return true
}

function handlePendingConnectionPointerMove(event: PointerEvent) {
  canvasMouseWorld.value = screenToWorld(event.clientX, event.clientY)
}

function handlePendingConnectionPointerUp(event: PointerEvent) {
  if (pendingConnectionTarget.value?.kind === 'step' && pendingConnectionTarget.value.stepId && connectPendingToStep(pendingConnectionTarget.value.stepId)) return
  if (
    pendingConnectionTarget.value?.kind === 'utility'
    && pendingConnectionTarget.value.utilityId
    && pendingConnectionTarget.value.utilityPortId
    && connectPendingToUtility(pendingConnectionTarget.value.utilityId, pendingConnectionTarget.value.utilityPortId)
  ) return
  if (maybeCreateNodeFromPendingPointer(event)) {
    cancelGraphConnection()
    return
  }
  cancelGraphConnection()
}

function beginCanvasPan(event: PointerEvent) {
  if ((event.target as HTMLElement).closest('.graph-node, .graph-note, .canvas-floating, .node-context-menu')) return
  const isMiddleButton = event.button === 1
  const isPrimaryPan = event.button === 0 && spacePanning.value
  const isMarqueeSelection = event.button === 0 && event.shiftKey && !spacePanning.value
  if (!isMiddleButton && !isPrimaryPan && !isMarqueeSelection && event.button !== 0) return
  closeContextMenu()
  if (isMarqueeSelection) {
    const world = screenToWorld(event.clientX, event.clientY)
    if (!world) return
    const rect = canvasViewportRef.value?.getBoundingClientRect()
    if (!rect) return
    selectionMarquee.value = {
      left: event.clientX - rect.left,
      top: event.clientY - rect.top,
      width: 0,
      height: 0,
    }
    dragState = {
      type: 'marquee',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      initialWorldPoint: world,
    }
  } else {
    dragState = {
      type: 'pan',
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      initialViewport: { ...viewport.value },
    }
  }
  event.preventDefault()
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  document.addEventListener('pointermove', handleGlobalPointerMove, true)
  document.addEventListener('pointerup', handleGlobalPointerUp, true)
}

function beginNodeDrag(key: string, selection: string, event: PointerEvent) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button, input, textarea, .n-base-selection, .n-input, .n-button')) return
  closeContextMenu()
  if (event.ctrlKey || event.metaKey) selectGraphNode(selection, { toggle: true })
  else selectGraphNode(selection)
  const selectionKeys = graphSelectionKeysForDrag(selection)
  dragState = {
    type: selectionKeys.length > 1 ? 'selection' : 'node',
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    nodeKey: key,
    selectionKeys,
    initialPoint: { ...nodePosition(key) },
    initialSelectionPoints: Object.fromEntries(selectionKeys.map(item => [item, nodeSelectionPoint(item)]).filter((entry): entry is [string, WorkflowCanvasPoint] => Boolean(entry[1]))),
  }
  event.preventDefault()
  event.stopPropagation()
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  document.addEventListener('pointermove', handleGlobalPointerMove, true)
  document.addEventListener('pointerup', handleGlobalPointerUp, true)
}

function beginNoteDrag(note: WorkflowNoteDraft, event: PointerEvent) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button, input, textarea, .n-input, .n-button')) return
  closeContextMenu()
  const selection = noteSelectionKey(note.id)
  if (event.ctrlKey || event.metaKey) selectGraphNode(selection, { toggle: true })
  else selectGraphNode(selection)
  const selectionKeys = graphSelectionKeysForDrag(selection)
  dragState = {
    type: selectionKeys.length > 1 ? 'selection' : 'note',
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    noteId: note.id,
    selectionKeys,
    initialPoint: { x: note.x, y: note.y },
    initialSelectionPoints: Object.fromEntries(selectionKeys.map(item => [item, nodeSelectionPoint(item)]).filter((entry): entry is [string, WorkflowCanvasPoint] => Boolean(entry[1]))),
  }
  event.preventDefault()
  event.stopPropagation()
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  document.addEventListener('pointermove', handleGlobalPointerMove, true)
  document.addEventListener('pointerup', handleGlobalPointerUp, true)
}

function handleGlobalPointerMove(event: PointerEvent) {
  if (!dragState || event.pointerId !== dragState.pointerId) return
  queuedPointer = event
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    if (!dragState || !queuedPointer) return
    const current = queuedPointer
    if (dragState.type === 'pan' && dragState.initialViewport) {
      viewport.value = {
        ...dragState.initialViewport,
        x: Math.round(dragState.initialViewport.x + current.clientX - dragState.startClientX),
        y: Math.round(dragState.initialViewport.y + current.clientY - dragState.startClientY),
      }
      return
    }
    if (dragState.type === 'marquee' && dragState.initialWorldPoint) {
      const rect = canvasViewportRef.value?.getBoundingClientRect()
      if (rect) {
        selectionMarquee.value = {
          left: Math.min(dragState.startClientX, current.clientX) - rect.left,
          top: Math.min(dragState.startClientY, current.clientY) - rect.top,
          width: Math.abs(current.clientX - dragState.startClientX),
          height: Math.abs(current.clientY - dragState.startClientY),
        }
      }
      return
    }
    if (dragState.type === 'selection' && dragState.selectionKeys && dragState.initialSelectionPoints) {
      const dx = (current.clientX - dragState.startClientX) / viewport.value.k
      const dy = (current.clientY - dragState.startClientY) / viewport.value.k
      dragState.selectionKeys.forEach((key) => {
        const base = dragState?.initialSelectionPoints?.[key]
        if (!base) return
        setSelectionKeyPosition(key, {
          x: base.x + dx,
          y: base.y + dy,
        })
      })
      return
    }
    if ((dragState.type === 'node' || dragState.type === 'note') && dragState.initialPoint) {
      const nextPoint = {
        x: dragState.initialPoint.x + (current.clientX - dragState.startClientX) / viewport.value.k,
        y: dragState.initialPoint.y + (current.clientY - dragState.startClientY) / viewport.value.k,
      }
      if (dragState.type === 'node' && dragState.nodeKey) {
        setNodePosition(dragState.nodeKey, nextPoint)
      }
      if (dragState.type === 'note' && dragState.noteId) {
        updateNotePosition(dragState.noteId, nextPoint)
      }
    }
  })
}

function cleanupPointerInteraction() {
  dragState = null
  queuedPointer = null
  selectionMarquee.value = null
  spacePanning.value = false
  finishHistoryGroup()
  document.removeEventListener('pointermove', handleGlobalPointerMove, true)
  document.removeEventListener('pointerup', handleGlobalPointerUp, true)
}

function handleGlobalPointerUp(event: PointerEvent) {
  if (!dragState || event.pointerId !== dragState.pointerId) return
  if (dragState.type === 'marquee' && dragState.initialWorldPoint) {
    const end = screenToWorld(event.clientX, event.clientY)
    if (end) applyMarqueeSelection(dragState.initialWorldPoint, end)
  }
  cleanupPointerInteraction()
}

function resetView() {
  viewport.value = { x: 0, y: 0, k: 1 }
}

async function fitView() {
  await nextTick()
  refreshViewportMetrics()
  const rect = canvasViewportRef.value?.getBoundingClientRect()
  if (!rect) return
  const width = Math.max(1, canvasBounds.value.width - WORLD_PADDING * 1.05)
  const height = Math.max(1, canvasBounds.value.height - WORLD_PADDING * 1.05)
  const scale = clampZoom(Math.min((rect.width - 96) / width, (rect.height - 96) / height, 1.1))
  viewport.value = {
    x: Math.round((rect.width - width * scale) / 2 - (canvasBounds.value.minX + WORLD_PADDING * 0.52) * scale),
    y: Math.round((rect.height - height * scale) / 2 - (canvasBounds.value.minY + WORLD_PADDING * 0.52) * scale),
    k: scale,
  }
}

function jumpMinimap(event: MouseEvent) {
  const rect = minimapRef.value?.getBoundingClientRect()
  if (!rect) return
  const rx = (event.clientX - rect.left) / rect.width
  const ry = (event.clientY - rect.top) / rect.height
  const worldX = canvasBounds.value.minX + canvasBounds.value.width * rx
  const worldY = canvasBounds.value.minY + canvasBounds.value.height * ry
  const scale = viewport.value.k
  viewport.value = {
    x: Math.round(viewportMetrics.value.width / 2 - worldX * scale),
    y: Math.round(viewportMetrics.value.height / 2 - worldY * scale),
    k: scale,
  }
}
</script>

<template>
  <div class="node-editor-frame">
    <div class="node-editor-shell">
      <section
        ref="canvasViewportRef"
        class="node-canvas-wrap"
        :class="{ 'node-canvas-wrap--space-panning': spacePanning }"
        :style="viewportStyle"
        @wheel="handleCanvasWheel"
        @contextmenu="handleCanvasContextMenu"
        @pointerdown="beginCanvasPan"
        @pointermove="handleCanvasPointerMove"
        @dblclick="openPalette(canvasMouseWorld || canvasCenterWorldPoint())"
      >
        <div class="node-canvas-grid" />

        <div class="canvas-primary-actions canvas-floating">
          <n-button size="small" secondary circle :title="t('common.undo')" :disabled="!canUndo" @click="undoGraphChange">
            <template #icon><n-icon :component="ArrowUndoOutline" /></template>
          </n-button>
          <n-button size="small" secondary circle :title="t('common.redo')" :disabled="!canRedo" @click="redoGraphChange">
            <template #icon><n-icon :component="ArrowRedoOutline" /></template>
          </n-button>
          <n-button size="small" secondary @click="addGraphStep">
            <template #icon><n-icon :component="AddOutline" /></template>
            {{ t('workflows.addSeparationNode') }}
          </n-button>
          <n-button size="small" secondary @click="addGraphNote()">
            {{ t('workflows.addNote') }}
          </n-button>
          <n-button size="small" quaternary @click="openPalette()">
            <template #icon><n-icon :component="SearchOutline" /></template>
            {{ t('workflows.quickAddNode') }}
          </n-button>
          <n-button size="small" quaternary @click="autoLayoutGraph">
            {{ t('workflows.autoLayout') }}
          </n-button>
        </div>

        <div v-if="pendingConnection" class="connection-banner canvas-floating" :class="{ 'connection-banner--locked': pendingConnectionTargetLabel }">
          <strong>{{ t('workflows.connectingFrom') }}</strong>
          <span>{{ pendingConnection.label }}</span>
          <small v-if="pendingConnectionTargetLabel" class="connection-banner__target">{{ t('workflows.pendingTarget') }}: {{ pendingConnectionTargetLabel }}</small>
          <n-button size="tiny" quaternary @click="cancelGraphConnection">{{ t('common.cancel') }}</n-button>
        </div>

        <div v-if="workflowValidationIssues.length" class="workflow-warning-banner canvas-floating">
          <strong>{{ t('workflows.workflowValidationTitle') }}</strong>
          <ul>
            <li v-for="issue in workflowValidationIssues" :key="issue.message">
              <button type="button" @click="focusValidationIssue(issue)">{{ issue.message }}</button>
            </li>
          </ul>
        </div>

        <div v-if="selectionMarquee" class="graph-selection-marquee" :style="selectionMarquee" />

        <div class="node-canvas-world">
          <div class="node-canvas-zoom" :style="zoomLayerStyle">
          <div class="node-canvas" :style="graphCanvasStyle">
            <svg class="node-canvas__edges" :width="canvasBounds.width" :height="canvasBounds.height" :viewBox="`0 0 ${canvasBounds.width} ${canvasBounds.height}`">
              <g v-for="edge in graphConnections" :key="edge.id">
                <path
                  :class="[
                    edge.className,
                    {
                      'workflow-edge--hovered': hoveredEdgeId === edge.id,
                    },
                  ]"
                  :d="shiftedConnectionPath(edge.path)"
                  fill="none"
                />
                <path
                  v-if="edge.kind === 'step-input' || edge.kind === 'utility-input'"
                  class="workflow-edge-hit"
                  :d="shiftedConnectionPath(edge.path)"
                  fill="none"
                  @pointerenter="hoveredEdgeId = edge.id"
                  @pointerleave="hoveredEdgeId = ''"
                  @click.stop="handleEdgeClick(edge)"
                />
              </g>
            </svg>

            <article
              data-selection-key="input"
              class="graph-node graph-node--input"
              :class="{ 'graph-node--selected': isGraphNodeSelected('input') }"
              :style="graphNodeStyle('input', { minHeight: `${inputNodeHeight()}px` })"
              @pointerdown="beginNodeDrag('input', 'input', $event)"
              @click="selectGraphNode('input', { append: $event.ctrlKey || $event.metaKey })"
            >
              <div class="graph-node__head graph-node__head--drag">
                <span>{{ t('workflows.inputNode') }}</span>
                <strong>{{ t('workflows.originalInput') }}</strong>
              </div>
              <button type="button" class="graph-port graph-port--output" @click.stop="beginGraphConnection('input', t('workflows.originalInput'))">
                <span>{{ t('workflows.audioOutput') }}</span>
                <i data-port-id="out:input" />
              </button>
            </article>

            <article
              v-for="(step, index) in steps"
              :key="stepRenderKey(step)"
              :data-selection-key="stepSelectionKey(step.id)"
              class="graph-node graph-node--step"
              :class="{ 'graph-node--selected': isGraphNodeSelected(stepSelectionKey(step.id)), 'graph-node--pending-target': isPendingTargetStep(step.id) }"
              :style="graphNodeStyle(step.id, { minHeight: `${stepNodeHeight(step)}px` })"
              @pointerdown="beginNodeDrag(step.id, stepSelectionKey(step.id), $event)"
              @click="selectGraphNode(stepSelectionKey(step.id), { append: $event.ctrlKey || $event.metaKey })"
            >
              <div class="graph-node__head graph-node__head--drag">
                <div class="graph-node__head-main">
                  <span>{{ t('workflows.separationNode') }}</span>
                  <strong>{{ stepDisplayId(index) }}</strong>
                </div>
                <div class="graph-node__head-actions">
                  <button
                    type="button"
                    class="graph-node__head-button graph-node__icon-action"
                    :title="t('workflows.nodeSettings')"
                    @click.stop="openStepConfig(step.id)"
                  >
                    <n-icon :component="SettingsOutline" />
                  </button>
                  <button
                    v-if="steps.length > 1 && !pendingConnection"
                    type="button"
                    class="graph-node__head-button graph-node__icon-action graph-node__icon-action--danger"
                    :title="t('workflows.deleteNode')"
                    @click.stop="removeGraphStep(step)"
                  >
                    <n-icon :component="CloseOutline" />
                  </button>
                  <button
                    type="button"
                    class="graph-node__head-button graph-node__collapse"
                    :title="isStepCollapsed(step.id) ? t('workflows.expandNode') : t('workflows.collapseNode')"
                    @click.stop="toggleStepCollapsed(step.id)"
                  >
                    <n-icon :component="isStepCollapsed(step.id) ? AddOutline : RemoveOutline" />
                  </button>
                </div>
              </div>
              <button
                type="button"
                class="graph-port graph-port--input"
                :class="{
                  'graph-port--armed': pendingConnection,
                  'graph-port--connected': step.input,
                  'graph-port--pending-target': isPendingTargetStep(step.id),
                }"
                @click.stop="connectGraphInput(index)"
              >
                <i :data-port-id="`in:${step.id}`" />
                <span>{{ step.input ? formatConnectionValueLabel(step.input) : t('workflows.stepInput') }}</span>
              </button>
              <div class="graph-node__model" :title="step.model || t('workflows.stepModelPlaceholder')">
                {{ step.model || t('workflows.stepModelPlaceholder') }}
              </div>
              <div v-if="!isStepCollapsed(step.id)" class="graph-node__ports">
                <button
                  v-for="stem in step.stems"
                  :key="stem"
                  type="button"
                  class="graph-port graph-port--output"
                  @click.stop="beginGraphConnection(stepStemValue(step, stem), stepStemLabelByIndex(index, stem))"
                >
                  <span>{{ stem }}</span>
                  <i :data-port-id="`out:${step.id}.${stem}`" />
                </button>
                <div v-if="!step.stems.length" class="graph-node__empty-port">{{ t('workflows.noStemPorts') }}</div>
              </div>
              <div v-if="isStepCollapsed(step.id)" class="graph-node__collapsed-summary">
                {{ step.stems.length ? `${step.stems.length} stems` : t('workflows.noStemPorts') }}
              </div>
            </article>

            <article
              v-for="note in notes"
              :key="note.id"
              :data-selection-key="noteSelectionKey(note.id)"
              class="graph-note"
              :class="[noteColorClass(note.color), { 'graph-note--selected': isGraphNodeSelected(noteSelectionKey(note.id)) }]"
              :style="noteNodeStyle(note)"
              @pointerdown="beginNoteDrag(note, $event)"
              @click="selectGraphNode(noteSelectionKey(note.id), { append: $event.ctrlKey || $event.metaKey })"
            >
              <div class="graph-note__actions-float">
                <button type="button" class="graph-note__delete" :title="t('workflows.deleteNote')" @click.stop="removeGraphNote(note.id)" @pointerdown.stop>×</button>
              </div>

              <input
                v-if="isEditingNoteField(note.id, 'title')"
                ref="noteEditInputRef"
                :value="note.title"
                class="graph-note__title graph-note__field"
                :style="noteTextStyle(note)"
                :placeholder="t('workflows.noteTitlePlaceholder')"
                @input="(event) => updateSelectedNote({ title: (event.target as HTMLInputElement).value })"
                @blur="finishNoteEdit"
                @keydown.enter.prevent="finishNoteEdit"
                @keydown.esc.prevent="finishNoteEdit"
                @click.stop
                @pointerdown.stop
              >
              <strong
                v-else
                class="graph-note__title graph-note__editable"
                :class="{ 'graph-note__title--empty': !note.title }"
                :style="noteTextStyle(note)"
                @dblclick.stop="beginNoteEdit(note.id, 'title')"
                @pointerdown.stop="beginNoteDrag(note, $event)"
              >{{ note.title || t('workflows.noteTitlePlaceholder') }}</strong>

              <textarea
                v-if="isEditingNoteField(note.id, 'content')"
                ref="noteEditInputRef"
                :value="note.content"
                rows="1"
                class="graph-note__body graph-note__field"
                :style="noteTextStyle(note)"
                :placeholder="t('workflows.noteContentPlaceholder')"
                @input="onNoteContentInput"
                @blur="finishNoteEdit"
                @keydown.esc.prevent="finishNoteEdit"
                @click.stop
                @pointerdown.stop
              />
              <p
                v-else
                class="graph-note__body graph-note__editable"
                :class="{ 'graph-note__body--empty': !note.content }"
                :style="noteTextStyle(note)"
                @dblclick.stop="beginNoteEdit(note.id, 'content')"
                @pointerdown.stop="beginNoteDrag(note, $event)"
              >{{ note.content || t('workflows.noteContentPlaceholder') }}</p>

              <div
                v-if="isGraphNodeSelected(noteSelectionKey(note.id))"
                class="graph-note__toolbar"
                @pointerdown.stop
                @click.stop
              >
                <div class="graph-note__swatches">
                  <button
                    v-for="option in noteColorOptions"
                    :key="option.value"
                    type="button"
                    class="graph-note__swatch"
                    :class="[`graph-note__color-dot--${option.value}`, { 'graph-note__swatch--active': note.color === option.value }]"
                    :title="option.label.value"
                    @click="updateSelectedNote({ color: option.value })"
                  />
                </div>
                <n-select
                  :value="noteFontSize(note)"
                  size="tiny"
                  class="graph-note__font-size"
                  :options="noteFontSizeOptions.map(size => ({ label: `${size}`, value: size }))"
                  @update:value="(value: number) => updateSelectedNote({ fontSize: value })"
                />
                <n-select
                  :value="note.fontFamily || ''"
                  size="tiny"
                  class="graph-note__font-family"
                  :options="noteFontFamilyOptions.map(item => ({ label: item.label.value, value: item.value }))"
                  @update:value="(value: string) => updateSelectedNote({ fontFamily: value })"
                />
              </div>
            </article>

            <article
              v-for="node in utilityNodes"
              :key="node.id"
              :data-selection-key="utilitySelectionKey(node.id)"
              class="graph-node graph-node--utility"
              :class="{ 'graph-node--selected': isGraphNodeSelected(utilitySelectionKey(node.id)), 'graph-node--pending-target': utilityInputPortIds(node).some(portId => isPendingTargetUtility(node.id, portId)) }"
              :style="utilityNodeStyle(node)"
              @pointerdown="beginNodeDrag(node.id, utilitySelectionKey(node.id), $event)"
              @click="selectGraphNode(utilitySelectionKey(node.id), { append: $event.ctrlKey || $event.metaKey })"
            >
              <div class="graph-node__head graph-node__head--drag">
                <div class="graph-node__head-main">
                  <span>{{ t('workflows.utilityNode') }}</span>
                  <strong>{{ utilityNodeTitle(node.kind) }}</strong>
                </div>
                <div class="graph-node__head-actions">
                  <button
                    type="button"
                    class="graph-node__head-button graph-node__icon-action"
                    :title="t('workflows.nodeSettings')"
                    @click.stop="openUtilityConfig(node.id)"
                  >
                    <n-icon :component="SettingsOutline" />
                  </button>
                  <button
                    type="button"
                    class="graph-node__head-button graph-node__icon-action graph-node__icon-action--danger"
                    :title="t('workflows.deleteNode')"
                    @click.stop="removeUtilityNode(node.id)"
                  >
                    <n-icon :component="CloseOutline" />
                  </button>
                </div>
              </div>
              <div class="graph-node__model" :title="utilityNodeSummary(node)">
                {{ utilityNodeSummary(node) }}
              </div>
              <div v-if="utilityNodeWarning(node)" class="graph-node__warning">
                {{ utilityNodeWarning(node) }}
              </div>
              <button
                v-else-if="utilityNodeTaskCountLabel(node)"
                type="button"
                class="graph-node__meta-line graph-node__meta-action"
                @click.stop="openUtilityConfig(node.id)"
              >
                {{ utilityNodeTaskCountLabel(node) }}
              </button>
              <button
                v-for="portId in utilityInputPortIds(node)"
                :key="`${node.id}:${portId}`"
                type="button"
                class="graph-port graph-port--input"
                :class="{
                  'graph-port--armed': pendingConnection,
                  'graph-port--connected': utilityInputValue(node, portId),
                  'graph-port--pending-target': isPendingTargetUtility(node.id, portId),
                }"
                @click.stop="connectUtilityInput(node.id, portId)"
              >
                <i :data-port-id="utilityInputPortToken(node.id, portId)" />
                <span>{{ utilityInputLabel(node, portId) }}</span>
              </button>
              <div class="graph-node__collapsed-summary">
                {{ utilityNodeMeta(node) }}
              </div>
              <button
                type="button"
                class="graph-port graph-port--output"
                @click.stop="beginGraphConnection(utilityOutputValue(node.id), utilityNodeDisplayLabel(node))"
              >
                <span>{{ t('workflows.audioOutput') }}</span>
                <i :data-port-id="utilityOutputPortToken(node.id)" />
              </button>
            </article>

            <article
              data-selection-key="save"
              class="graph-node graph-node--save"
              :class="{ 'graph-node--selected': isGraphNodeSelected('save') }"
              :style="graphNodeStyle('save', { minHeight: `${saveNodeHeight()}px` })"
              @pointerdown="beginNodeDrag('save', 'save', $event)"
              @click="selectGraphNode('save', { append: $event.ctrlKey || $event.metaKey })"
            >
              <div class="graph-node__head graph-node__head--drag">
                <div class="graph-node__head-main">
                  <span>{{ t('workflows.saveNode') }}</span>
                  <strong>{{ t('workflows.generatedOutputs') }}</strong>
                </div>
                <div class="graph-node__head-actions">
                  <button
                    type="button"
                    class="graph-node__head-button graph-node__icon-action"
                    :title="t('workflows.nodeSettings')"
                    @click.stop="openSaveConfig"
                  >
                    <n-icon :component="SettingsOutline" />
                  </button>
                </div>
              </div>
              <div class="graph-node__ports graph-node__ports--save">
                <div v-for="(item, index) in saveOutputs" :key="item.key" class="graph-port graph-port--input graph-port--readonly graph-port--save-item">
                  <i :data-port-id="`in:save:${index}`" />
                  <span class="graph-port__content">
                    <strong>{{ item.label }}</strong>
                    <small>{{ item.outputDir || (item.type === 'step' ? item.stem : '') }}</small>
                  </span>
                </div>
                <div v-if="!saveOutputs.length" class="graph-node__empty-port">{{ t('workflows.noSavedOutputs') }}</div>
              </div>
            </article>
          </div>
          </div>
        </div>

        <div v-if="contextMenu.show" class="node-context-menu canvas-floating" :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }">
          <template v-if="contextMenu.mode === 'selection'">
            <div class="node-context-menu__label">{{ t('workflows.selectionActions') }}</div>
            <button type="button" @click="clearGraphSelection(selectedGraphNode || 'input'); closeContextMenu()">{{ t('workflows.clearSelection') }}</button>
            <button type="button" :disabled="!canAlignSelection" @click="alignSelectedNodes('x'); closeContextMenu()">{{ t('workflows.alignLeft') }}</button>
            <button type="button" :disabled="!canAlignSelection" @click="alignSelectedNodes('y'); closeContextMenu()">{{ t('workflows.alignTop') }}</button>
            <button type="button" :disabled="!canDistributeSelection" @click="distributeSelectedNodes('x'); closeContextMenu()">{{ t('workflows.distributeHorizontally') }}</button>
            <button type="button" :disabled="!canDistributeSelection" @click="distributeSelectedNodes('y'); closeContextMenu()">{{ t('workflows.distributeVertically') }}</button>
            <button type="button" :disabled="!hasDuplicableSelection" @click="copySelectedGraphNodes(); closeContextMenu()">{{ t('workflows.copySelectedNodes') }}</button>
            <button type="button" :disabled="!canPasteGraphNodes" @click="pasteGraphNodes(); closeContextMenu()">{{ t('workflows.pasteCopiedNodes') }}</button>
            <button type="button" :disabled="!hasDuplicableSelection" @click="duplicateSelectedGraphNode(); closeContextMenu()">{{ t('workflows.duplicateSelected') }}</button>
            <button type="button" :disabled="!hasRemovableSelection" @click="removeSelectedGraphNode(); closeContextMenu()">{{ t('workflows.deleteSelectedNodes') }}</button>
          </template>
          <template v-else>
            <button type="button" @click="addGraphStepAt(contextMenu.world || undefined); closeContextMenu()">{{ t('workflows.addSeparationNode') }}</button>
            <button type="button" @click="addGraphNote(contextMenu.world || undefined); closeContextMenu()">{{ t('workflows.addNote') }}</button>
            <button type="button" @click="openPalette(contextMenu.world || undefined); closeContextMenu()">{{ t('workflows.quickAddNode') }}</button>
            <button type="button" :disabled="!canPasteGraphNodes" @click="pasteGraphNodes(); closeContextMenu()">{{ t('workflows.pasteCopiedNodes') }}</button>
            <button type="button" @click="autoLayoutGraph(); closeContextMenu()">{{ t('workflows.autoLayout') }}</button>
          </template>
        </div>

        <div class="canvas-zoom-controls canvas-floating">
          <n-button size="tiny" secondary @click="zoomBy(1 / ZOOM_STEP)">-</n-button>
          <strong>{{ zoomPercent }}%</strong>
          <n-button size="tiny" secondary @click="zoomBy(ZOOM_STEP)">+</n-button>
          <n-button size="tiny" quaternary @click="fitView">{{ t('workflows.fitView') }}</n-button>
          <n-button size="tiny" quaternary @click="resetView">{{ t('workflows.resetView') }}</n-button>
        </div>

        <div v-if="hasMultipleSelection && selectionToolbarStyle" class="canvas-selection-controls canvas-floating" :style="selectionToolbarStyle">
          <span>{{ t('workflows.selectedCount', { count: selectedGraphNodes.length }) }}</span>
          <n-button size="tiny" quaternary @click="clearGraphSelection(selectedGraphNode || 'input')">{{ t('workflows.clearSelection') }}</n-button>
          <n-button size="tiny" quaternary :disabled="!hasDuplicableSelection" @click="copySelectedGraphNodes()">{{ t('workflows.copySelectedNodes') }}</n-button>
          <n-button size="tiny" quaternary :disabled="!canPasteGraphNodes" @click="pasteGraphNodes()">{{ t('workflows.pasteCopiedNodes') }}</n-button>
          <n-button size="tiny" quaternary :disabled="!hasDuplicableSelection" @click="duplicateSelectedGraphNode()">{{ t('workflows.duplicateSelected') }}</n-button>
          <n-button size="tiny" quaternary :disabled="!hasRemovableSelection" @click="removeSelectedGraphNode()">{{ t('workflows.deleteSelectedNodes') }}</n-button>
          <n-button size="tiny" quaternary :disabled="!canAlignSelection" @click="alignSelectedNodes('x')">{{ t('workflows.alignLeft') }}</n-button>
          <n-button size="tiny" quaternary :disabled="!canAlignSelection" @click="alignSelectedNodes('y')">{{ t('workflows.alignTop') }}</n-button>
          <n-button size="tiny" quaternary :disabled="!canDistributeSelection" @click="distributeSelectedNodes('x')">{{ t('workflows.distributeHorizontally') }}</n-button>
          <n-button size="tiny" quaternary :disabled="!canDistributeSelection" @click="distributeSelectedNodes('y')">{{ t('workflows.distributeVertically') }}</n-button>
        </div>


        <div ref="minimapRef" class="canvas-minimap canvas-floating" @click="jumpMinimap">
          <svg :viewBox="`${canvasBounds.minX} ${canvasBounds.minY} ${canvasBounds.width} ${canvasBounds.height}`" preserveAspectRatio="none">
            <rect class="minimap-bg" :x="canvasBounds.minX" :y="canvasBounds.minY" :width="canvasBounds.width" :height="canvasBounds.height" rx="20" />
            <rect
              v-for="step in steps"
              :key="step.id"
              class="minimap-node minimap-node--step"
              :x="nodePosition(step.id).x"
              :y="nodePosition(step.id).y"
              :width="GRAPH_NODE_WIDTH"
              :height="stepNodeHeight(step)"
              rx="18"
            />
            <rect class="minimap-node minimap-node--input" :x="nodePosition('input').x" :y="nodePosition('input').y" :width="GRAPH_NODE_WIDTH" height="120" rx="18" />
            <rect class="minimap-node minimap-node--save" :x="nodePosition('save').x" :y="nodePosition('save').y" :width="GRAPH_NODE_WIDTH" :height="saveNodeHeight()" rx="18" />
            <rect
              v-for="node in utilityNodes"
              :key="node.id"
              class="minimap-node minimap-node--utility"
              :x="nodePosition(node.id).x"
              :y="nodePosition(node.id).y"
              :width="utilityNodeWidth(node.kind)"
              :height="utilityNodeHeight(node)"
              rx="18"
            />
            <rect
              v-for="note in notes"
              :key="note.id"
              class="minimap-note"
              :x="note.x"
              :y="note.y"
              :width="NOTE_WIDTH"
              :height="noteHeight(note)"
              rx="16"
            />
            <rect
              class="minimap-viewport"
              :x="minimapViewportRect.x"
              :y="minimapViewportRect.y"
              :width="minimapViewportRect.width"
              :height="minimapViewportRect.height"
              rx="18"
            />
          </svg>
        </div>
      </section>
    </div>

    <footer class="node-editor-footer">
      <span :class="props.formError ? 'json-error' : 'json-ok'">{{ props.formError || t('workflows.formValid') }}</span>
      <div>
        <n-button type="primary" :disabled="!props.canSave" @click="emit('save', currentDefinitionSnapshot())">{{ t('common.save') }}</n-button>
      </div>
    </footer>

    <n-modal v-model:show="paletteOpen" preset="card" class="node-palette-modal" :title="t('workflows.quickAddNode')" :bordered="false" size="small" style="width: min(520px, calc(100vw - 96px))">
      <div class="node-palette">
        <n-input v-model:value="paletteSearch" clearable :placeholder="t('workflows.searchNodeTypes')" />
        <div class="node-palette__list">
          <button v-for="item in paletteItems" :key="item.kind" type="button" class="node-palette__item" @click="applyPaletteItem(item.kind)">
            <strong>{{ item.title }}</strong>
            <span>{{ item.desc }}</span>
          </button>
          <div v-if="!paletteItems.length" class="node-palette__empty">{{ t('workflows.noPaletteResults') }}</div>
        </div>
      </div>
    </n-modal>

    <n-modal
      :show="Boolean(stepConfigStep)"
      preset="card"
      class="node-config-modal"
      style="width: min(560px, calc(100vw - 32px))"
      :title="stepConfigStep ? `${t('workflows.separationNode')} · ${stepDisplayIdByStep(stepConfigStep)}` : t('workflows.separationNode')"
      :bordered="false"
      size="medium"
      @update:show="(value: boolean) => { if (!value) closeStepConfig() }"
    >
      <div v-if="stepConfigStep" class="node-config-form">
        <div class="node-config-actions">
          <n-button size="small" secondary @click="duplicateGraphStep(stepConfigStep)">
            <template #icon><n-icon :component="CopyOutline" /></template>
            {{ t('workflows.duplicateNode') }}
          </n-button>
          <n-button size="small" secondary :disabled="!stepConfigStepAvailableStemValues.length" @click="applyAllModelStems(stepConfigStep)">
            {{ t('workflows.useAllStems') }}
          </n-button>
          <n-button size="small" tertiary type="error" :disabled="steps.length <= 1" @click="removeGraphStep(stepConfigStep); closeStepConfig()">
            <template #icon><n-icon :component="TrashOutline" /></template>
            {{ t('workflows.deleteNode') }}
          </n-button>
        </div>

        <label>
          <span>{{ t('workflows.stepModel') }}</span>
          <n-select
            :value="stepConfigStepModel"
            filterable
            :options="props.modelOptions"
            :placeholder="t('workflows.stepModelPlaceholder')"
            @update:value="updateStepConfigModel"
          />
        </label>

        <label>
          <span>{{ t('workflows.stepInput') }}</span>
          <n-select
            :value="stepConfigStepInput"
            filterable
            tag
            :options="stepConfigStepInputOptions"
            :placeholder="t('workflows.stepInputPlaceholder')"
            @update:value="updateStepConfigInput"
          />
        </label>

        <label>
          <span>{{ t('workflows.stepOverlap') }}</span>
          <n-input-number
            :value="stepConfigStepOverlap"
            clearable
            :min="0"
            :step="1024"
            style="width: 100%"
            @update:value="updateStepConfigOverlap"
          />
        </label>

        <label>
          <span>{{ t('workflows.stepStems') }}</span>
          <n-select
            :value="stepConfigStepStems"
            multiple
            filterable
            tag
            :options="stepConfigStepStemOptions"
            :placeholder="t('workflows.stepStemsPlaceholder')"
            @update:value="updateStepConfigStems"
          />
        </label>

        <div class="node-config-actions node-config-actions--secondary">
          <n-button size="small" quaternary @click="resetStepInput(stepConfigStep, stepConfigStepIndex)">{{ t('workflows.resetInput') }}</n-button>
          <n-button size="small" quaternary @click="clearStepStems(stepConfigStep)">{{ t('workflows.clearStems') }}</n-button>
        </div>
      </div>
    </n-modal>

    <n-modal
      :show="saveConfigOpen"
      preset="card"
      class="node-config-modal"
      style="width: min(540px, calc(100vw - 32px))"
      :title="`${t('workflows.saveNode')} · ${t('workflows.generatedOutputs')}`"
      :bordered="false"
      size="medium"
      @update:show="(value: boolean) => { if (!value) closeSaveConfig() }"
    >
      <div class="node-config-form">
        <span class="graph-node__hint">{{ t('workflows.saveOutputDirHint') }}</span>
        <label v-for="item in saveOutputs" :key="item.key">
          <span>{{ item.label }}</span>
          <n-input
            :value="item.outputDir"
            size="small"
            :placeholder="item.type === 'step' ? item.stem : ''"
            @update:value="(value: string) => updateSaveOutputDir(item, value)"
          />
        </label>
      </div>
    </n-modal>

    <n-modal
      :show="Boolean(utilityConfigNode)"
      preset="card"
      class="node-config-modal"
      style="width: min(560px, calc(100vw - 32px))"
      :title="utilityConfigNode ? utilityNodeTitle(utilityConfigNode.kind) : t('workflows.utilityNode')"
      :bordered="false"
      size="medium"
      @update:show="(value: boolean) => { if (!value) closeUtilityConfig() }"
    >
      <div v-if="utilityConfigNode" class="node-config-form">
        <span class="graph-node__hint">{{ t('workflows.utilityNodeRuntimeHint') }}</span>

        <template v-if="utilityConfigKind === 'load_audio_batch'">
          <span class="graph-node__hint">{{ t('workflows.batchInputRuntimeHint') }}</span>
          <label>
            <span>{{ t('workflows.batchInputFolder') }}</span>
            <n-input-group>
              <n-input
                :value="String(utilityConfigData.folder || '')"
                :placeholder="t('workflows.batchInputFolderPlaceholder')"
                @update:value="(value: string) => updateUtilityConfigData({ folder: value })"
              />
              <n-button secondary @click="browseUtilityBatchFolder">
                {{ t('common.browse') }}
              </n-button>
            </n-input-group>
          </label>
          <label>
            <span>{{ t('workflows.recursive') }}</span>
            <n-switch
              :value="Boolean(utilityConfigData.recursive)"
              @update:value="(value: boolean) => updateUtilityConfigData({ recursive: value })"
            />
          </label>
          <label>
            <span>{{ t('workflows.sortFiles') }}</span>
            <n-switch
              :value="utilityConfigData.sortFiles === undefined ? true : Boolean(utilityConfigData.sortFiles)"
              @update:value="(value: boolean) => updateUtilityConfigData({ sortFiles: value })"
            />
          </label>
          <div class="node-config-preview">
            <div class="node-config-preview__head">
              <strong>{{ t('workflows.batchInputPreviewTitle') }}</strong>
              <div class="node-config-preview__actions">
                <n-button
                  size="tiny"
                  quaternary
                  :disabled="!String(utilityConfigData.folder || '').trim()"
                  @click="openUtilityBatchFolder"
                >
                  {{ t('workflows.openBatchInputFolder') }}
                </n-button>
                <n-button size="tiny" quaternary @click="refreshUtilityBatchPreview">
                  {{ t('common.refresh') }}
                </n-button>
              </div>
            </div>
            <span class="graph-node__hint">{{ t('workflows.batchInputPreviewHint') }}</span>
            <div v-if="!String(utilityConfigData.folder || '').trim()" class="node-config-preview__state">
              {{ t('workflows.batchInputPreviewEmpty') }}
            </div>
            <div v-else-if="utilityBatchPreviewLoading" class="node-config-preview__state">
              {{ t('workflows.batchInputPreviewLoading') }}
            </div>
            <div v-else-if="utilityBatchPreviewError" class="node-config-preview__state node-config-preview__state--error">
              {{ utilityBatchPreviewError }}
            </div>
            <template v-else>
              <div class="node-config-preview__stats">
                <strong>{{ t('workflows.batchInputPreviewCount', { count: utilityBatchPreview?.files.length || 0 }) }}</strong>
                <span>
                  {{ t(Boolean(utilityConfigData.recursive) ? 'workflows.batchInputRecursiveOn' : 'workflows.batchInputRecursiveOff') }}
                  ·
                  {{ t(utilityConfigData.sortFiles === undefined ? 'workflows.batchInputSortOn' : (Boolean(utilityConfigData.sortFiles) ? 'workflows.batchInputSortOn' : 'workflows.batchInputSortOff')) }}
                </span>
                <span v-if="utilityBatchPreview?.warnings?.length">
                  {{ t('workflows.batchInputPreviewWarnings', { count: utilityBatchPreview.warnings.length }) }}
                </span>
              </div>
              <div v-if="utilityBatchPreview?.files?.length" class="node-config-preview__files">
                <strong>{{ t('workflows.batchInputPreviewFilesTitle') }}</strong>
                <ul class="node-config-preview__file-list">
                  <li v-for="file in utilityBatchPreview.files.slice(0, 5)" :key="file" :title="file">
                    {{ baseName(file) }}
                  </li>
                </ul>
                <span v-if="utilityBatchPreview.files.length > 5" class="graph-node__hint">
                  {{ t('workflows.batchInputPreviewMoreFiles', { count: utilityBatchPreview.files.length - 5 }) }}
                </span>
              </div>
              <ul v-if="utilityBatchPreview?.warnings?.length" class="node-config-preview__warnings">
                <li v-for="warning in utilityBatchPreview.warnings.slice(0, 3)" :key="warning">{{ warning }}</li>
              </ul>
            </template>
          </div>
        </template>

        <template v-else-if="utilityConfigKind === 'audio_ensemble'">
          <label>
            <span>{{ t('workflows.inputCount') }}</span>
            <n-input-number
              :value="utilityConfigInputCount"
              :min="2"
              :max="10"
              style="width: 100%"
              @update:value="updateUtilityConfigInputCount"
            />
          </label>
          <label>
            <span>{{ t('workflows.ensembleType') }}</span>
            <n-select
              :value="String(utilityConfigData.ensembleType || 'avg_wave')"
              :options="[
                'avg_wave','median_wave','min_wave','max_wave','avg_fft','median_fft','min_fft','max_fft',
              ].map(item => ({ label: item, value: item }))"
              @update:value="(value: string) => updateUtilityConfigData({ ensembleType: value })"
            />
          </label>
          <label>
            <span>{{ t('workflows.weights') }}</span>
            <div class="utility-weight-grid">
              <div
                v-for="index in utilityConfigInputCount"
                :key="index"
                class="utility-weight-item"
              >
                <strong>W{{ index }}</strong>
                <n-input-number
                  :value="Number((Array.isArray(utilityConfigData.weights) ? utilityConfigData.weights[index - 1] : 1) || 1)"
                  :min="0"
                  :step="0.1"
                  style="width: 100%"
                  @update:value="(value: number | null) => updateUtilityConfigWeight(index - 1, value)"
                />
              </div>
            </div>
          </label>
        </template>
      </div>
    </n-modal>
  </div>
</template>

<style scoped>
.node-editor-frame {
  min-height: 0;
  height: 100%;
  display: grid;
  grid-template-rows: minmax(0, 1fr) auto;
  overflow: hidden;
  border: 0;
  border-radius: 18px;
  background:
    radial-gradient(circle at 28% 0%, color-mix(in srgb, var(--primary-soft) 20%, transparent), transparent 34%),
    color-mix(in srgb, var(--surface-1) 84%, transparent);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--outline) 78%, transparent),
    0 22px 54px rgba(0, 0, 0, 0.14);
}

.node-editor-shell {
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  overflow: hidden;
}

.graph-node__detail label > span {
  font-size: 13px;
}

.graph-node__hint {
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
}

.connection-banner {
  position: absolute;
  top: 64px;
  left: 14px;
  z-index: 10;
  display: grid;
  gap: 6px;
  width: min(280px, calc(100% - 28px));
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--primary) 36%, var(--outline));
  border-radius: 12px;
  background: color-mix(in srgb, var(--primary-soft) 24%, var(--surface-1));
}

.connection-banner--locked {
  border-color: color-mix(in srgb, #22c55e 54%, var(--outline));
  background: color-mix(in srgb, #22c55e 12%, var(--surface-1));
}

.connection-banner strong {
  font-size: 12px;
}

.connection-banner span {
  color: var(--primary-strong);
  font-size: 12px;
  word-break: break-all;
}

.connection-banner__target {
  display: block;
  color: color-mix(in srgb, #22c55e 72%, white 8%);
  font-size: 12px;
  line-height: 1.45;
}

.workflow-warning-banner {
  position: absolute;
  top: 68px;
  left: 14px;
  z-index: 11;
  display: grid;
  gap: 6px;
  width: min(320px, calc(100% - 28px));
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, #f59e0b 56%, var(--outline));
  border-radius: 12px;
  background: color-mix(in srgb, #f59e0b 14%, var(--surface-1));
  box-shadow: 0 14px 34px rgba(0, 0, 0, 0.12);
}

.workflow-warning-banner strong {
  font-size: 12px;
}

.workflow-warning-banner ul {
  margin: 0;
  padding-left: 18px;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
}

.workflow-warning-banner li + li {
  margin-top: 2px;
}

.workflow-warning-banner button {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.workflow-warning-banner button:hover {
  color: var(--on-surface);
  text-decoration: underline;
}

.legend-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  display: inline-block;
}

.legend-dot--audio {
  background: #22c55e;
}

.legend-dot--save {
  background: #f2c94c;
}

.legend-dot--note {
  background: #f59e0b;
}

.node-canvas-wrap {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background-color: color-mix(in srgb, var(--surface-1) 88%, transparent);
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.node-canvas-wrap:active,
.node-canvas-wrap--space-panning {
  cursor: grabbing;
}

.node-canvas-grid {
  pointer-events: none;
  position: absolute;
  inset: 0;
  opacity: 0.56;
  background-image:
    linear-gradient(color-mix(in srgb, var(--outline) 22%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--outline) 22%, transparent) 1px, transparent 1px);
  background-size: var(--grid-size) var(--grid-size);
  background-position: var(--grid-x) var(--grid-y);
}

.graph-selection-marquee {
  position: absolute;
  z-index: 8;
  border: 1px solid color-mix(in srgb, var(--primary) 68%, white);
  background: color-mix(in srgb, var(--primary-soft) 34%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgba(255,255,255,0.28) 72%, transparent);
  pointer-events: none;
}

.canvas-floating {
  pointer-events: auto;
  position: absolute;
  z-index: 20;
  border: 0;
  border-radius: 14px;
  background: color-mix(in srgb, var(--surface-1) 90%, transparent);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--outline) 76%, transparent),
    0 14px 34px rgba(0, 0, 0, 0.16);
  backdrop-filter: blur(18px) saturate(1.1);
}

.canvas-primary-actions {
  position: absolute;
  left: 14px;
  top: 14px;
  z-index: 30;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px;
  border-radius: 14px;
}

.node-canvas-world {
  position: absolute;
  inset: 0;
  transform: translate(var(--viewport-x), var(--viewport-y));
  will-change: transform;
  z-index: 2;
}

.node-canvas-zoom {
  position: absolute;
  inset: 0;
  transform-origin: top left;
}

.node-canvas {
  position: absolute;
}

.node-canvas__edges {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
}

.workflow-edge {
  stroke-width: 2.5;
  stroke-linecap: round;
  opacity: 0.82;
  filter: drop-shadow(0 0 7px color-mix(in srgb, var(--primary-glow) 32%, transparent));
  pointer-events: none;
  transition: stroke 140ms ease, opacity 140ms ease, filter 140ms ease;
}

.workflow-edge--input {
  stroke: color-mix(in srgb, #22c55e 72%, var(--primary));
}

.workflow-edge--save {
  stroke: color-mix(in srgb, #f2c94c 82%, var(--primary));
  stroke-dasharray: 6 5;
}

.workflow-edge--pending {
  stroke: color-mix(in srgb, var(--primary) 82%, #22c55e);
  stroke-dasharray: 8 7;
  opacity: 0.72;
}

.workflow-edge-hit {
  stroke: transparent;
  stroke-width: 14;
  stroke-linecap: round;
  pointer-events: stroke;
  cursor: pointer;
}

.graph-node,
.graph-note {
  pointer-events: auto;
}

.workflow-edge--hovered {
  opacity: 1;
  stroke: var(--danger);
  filter: drop-shadow(0 0 8px color-mix(in srgb, var(--danger) 36%, transparent));
}

.graph-node,
.graph-note {
  position: absolute;
  transition: border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
}

.graph-node {
  display: grid;
  gap: 10px;
  padding: 12px;
  border: 0;
  border-radius: 16px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.05), transparent 52%),
    color-mix(in srgb, var(--surface-2) 90%, var(--surface-1));
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--outline) 74%, transparent),
    0 16px 38px rgba(0, 0, 0, 0.16);
  cursor: grab;
}

.graph-note__delete {
  width: 20px;
  height: 20px;
  border: 1px solid color-mix(in srgb, var(--danger) 24%, transparent);
  border-radius: 999px;
  display: grid;
  place-items: center;
  color: var(--danger);
  background: color-mix(in srgb, var(--surface-1) 88%, transparent);
  box-shadow: 0 8px 18px rgba(0, 0, 0, 0.12);
  cursor: pointer;
  font: inherit;
  font-size: 14px;
  line-height: 1;
}

.graph-note__delete:hover {
  color: #fff;
  background: var(--danger);
  border-color: var(--danger);
}

.graph-node:hover {
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--primary) 44%, var(--outline)),
    0 16px 38px rgba(0, 0, 0, 0.18);
}

.graph-note:hover {
  border-color: color-mix(in srgb, var(--primary) 32%, var(--outline));
}

.graph-node--selected {
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--primary) 80%, var(--outline)),
    0 18px 44px rgba(0, 0, 0, 0.2),
    0 0 0 3px color-mix(in srgb, var(--primary-soft) 42%, transparent);
}

.graph-note--selected {
  border-color: color-mix(in srgb, var(--primary) 70%, var(--outline));
  box-shadow:
    0 18px 42px rgba(0, 0, 0, 0.14),
    0 0 0 3px color-mix(in srgb, var(--primary-soft) 40%, transparent);
}

.graph-node--pending-target {
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, #22c55e 74%, var(--primary)),
    0 18px 44px rgba(0, 0, 0, 0.2),
    0 0 0 3px rgba(34, 197, 94, 0.2);
}

.graph-node__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.graph-node__head--drag {
  cursor: grab;
}

.graph-node__head-main {
  min-width: 0;
  display: grid;
  gap: 4px;
}

.graph-node__head-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}

.graph-node__head-button {
  flex: 0 0 auto;
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 999px;
  display: grid;
  place-items: center;
}

.graph-node__head span {
  color: var(--on-surface-muted);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.graph-node--input .graph-node__head span {
  color: color-mix(in srgb, #22c55e 78%, var(--on-surface-muted));
}

.graph-node--step .graph-node__head span {
  color: color-mix(in srgb, var(--primary-strong) 82%, var(--on-surface-muted));
}

.graph-node--utility .graph-node__head span {
  color: color-mix(in srgb, #60a5fa 80%, var(--on-surface-muted));
}

.graph-node--save .graph-node__head span {
  color: color-mix(in srgb, #f2c94c 82%, var(--on-surface-muted));
}

.graph-node__head strong,
.graph-note strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}

.graph-node__collapse {
  border: 1px solid color-mix(in srgb, var(--outline) 52%, transparent);
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-1) 88%, transparent);
  cursor: pointer;
  font: inherit;
  font-size: 16px;
  line-height: 1;
}

.graph-node__icon-action {
  border: 1px solid color-mix(in srgb, var(--outline) 52%, transparent);
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-1) 88%, transparent);
  cursor: pointer;
  font: inherit;
  font-size: 13px;
  line-height: 1;
}

.graph-node__collapse :deep(.n-icon),
.graph-node__icon-action :deep(.n-icon) {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  line-height: 1;
  transform: translateY(0);
}

.graph-node__collapse :deep(svg),
.graph-node__icon-action :deep(svg) {
  display: block;
  width: 14px;
  height: 14px;
}

.graph-node__icon-action:hover,
.graph-node__collapse:hover {
  color: var(--primary-strong);
  border-color: color-mix(in srgb, var(--primary) 38%, var(--outline));
  background: color-mix(in srgb, var(--primary-soft) 20%, var(--surface-1));
}

.graph-node__icon-action--danger {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 32%, var(--outline));
}

.graph-node__icon-action--danger:hover {
  color: #fff;
  background: var(--danger);
  border-color: var(--danger);
}

.graph-node__model {
  min-height: 32px;
  display: grid;
  align-items: center;
  padding: 8px 10px;
  border-radius: 10px;
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-1) 72%, transparent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.graph-node__warning {
  margin-top: 8px;
  padding: 6px 8px;
  border: 1px solid color-mix(in srgb, #f59e0b 52%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, #f59e0b 12%, transparent);
  color: color-mix(in srgb, #f59e0b 78%, white 10%);
  font-size: 12px;
  line-height: 1.45;
}

.graph-node__meta-line {
  margin-top: 8px;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.45;
}

.graph-node__meta-action {
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.graph-node__meta-action:hover {
  color: var(--primary-strong);
}

.graph-node__ports {
  display: grid;
  gap: 6px;
}

.graph-node__ports--save {
  max-height: 188px;
  overflow: auto;
  padding-right: 2px;
}

.graph-node__detail {
  display: grid;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid color-mix(in srgb, var(--outline) 44%, transparent);
}

.graph-node__detail--form {
  max-height: 214px;
  overflow: auto;
  padding-right: 2px;
}

.graph-node__detail label {
  display: grid;
  gap: 6px;
}

.graph-node__detail label > span {
  color: var(--on-surface-muted);
  font-size: 11px;
  font-weight: 700;
}

.graph-node__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.graph-node__actions--secondary {
  padding-top: 2px;
}

.graph-node__empty-port {
  padding: 8px 10px;
  border: 1px dashed color-mix(in srgb, var(--outline) 55%, transparent);
  border-radius: 10px;
  color: var(--on-surface-muted);
  font-size: 12px;
}

.graph-node__collapsed-summary {
  padding: 8px 10px;
  border-radius: 10px;
  color: var(--on-surface-muted);
  background: color-mix(in srgb, var(--surface-1) 68%, transparent);
  font-size: 12px;
}

.graph-port {
  width: 100%;
  min-height: 28px;
  border: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 10px;
  color: var(--on-surface);
  background: color-mix(in srgb, var(--surface-1) 70%, transparent);
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.graph-port:hover,
.graph-port--armed {
  background: color-mix(in srgb, var(--primary-soft) 30%, var(--surface-1));
}

.graph-port--readonly {
  cursor: default;
}

.graph-port--connected {
  outline: 1px solid color-mix(in srgb, #22c55e 28%, transparent);
}

.graph-port--pending-target {
  outline: 2px solid color-mix(in srgb, #22c55e 62%, transparent);
  border-color: color-mix(in srgb, #22c55e 48%, var(--outline));
  background: color-mix(in srgb, #22c55e 16%, var(--surface-1));
  box-shadow: 0 0 0 4px color-mix(in srgb, rgba(34, 197, 94, 0.18) 88%, transparent);
}

.graph-port span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.graph-port__content {
  min-width: 0;
  display: grid;
  gap: 2px;
}

.graph-port__content strong,
.graph-port__content small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.graph-port__content strong {
  font-size: 12px;
  font-weight: 700;
}

.graph-port__content small {
  color: var(--on-surface-muted);
  font-size: 11px;
}

.graph-port i {
  flex: 0 0 auto;
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: #22c55e;
  box-shadow: 0 0 0 3px color-mix(in srgb, #22c55e 18%, transparent);
}

.graph-port--input {
  justify-content: flex-start;
}

.graph-port--save-item {
  align-items: flex-start;
}

.graph-node--save .graph-port i {
  background: #f2c94c;
  box-shadow: 0 0 0 3px color-mix(in srgb, #f2c94c 18%, transparent);
}

.graph-node--utility {
  background:
    linear-gradient(180deg, rgba(96, 165, 250, 0.08), transparent 64%),
    color-mix(in srgb, var(--surface-1) 82%, transparent);
}

.graph-note {
  position: relative;
  display: grid;
  gap: 4px;
  align-content: start;
  padding: 10px 12px;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 14px;
  box-shadow: 0 14px 30px rgba(0, 0, 0, 0.1);
  cursor: grab;
}

.graph-note__title {
  margin: 0;
  padding-right: 22px;
  color: var(--on-surface);
  font-size: 13px;
  font-weight: 800;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
}

.graph-note__body {
  margin: 0;
  color: color-mix(in srgb, var(--on-surface) 84%, var(--on-surface-muted));
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.graph-note--amber {
  background: linear-gradient(180deg, rgba(255,255,255,0.12), transparent 40%), rgba(245, 158, 11, 0.18);
}

.graph-note--blue {
  background: linear-gradient(180deg, rgba(255,255,255,0.12), transparent 40%), rgba(59, 130, 246, 0.16);
}

.graph-note--green {
  background: linear-gradient(180deg, rgba(255,255,255,0.12), transparent 40%), rgba(16, 185, 129, 0.16);
}

.graph-note--rose {
  background: linear-gradient(180deg, rgba(255,255,255,0.12), transparent 40%), rgba(244, 63, 94, 0.16);
}

.graph-note__actions-float {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 3;
  opacity: 0;
  transition: opacity 120ms ease;
}

.graph-note:hover .graph-note__actions-float,
.graph-note--selected .graph-note__actions-float {
  opacity: 1;
}

.graph-note__toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.graph-note__swatches {
  display: flex;
  align-items: center;
  gap: 4px;
}

.graph-note__swatch {
  width: 14px;
  height: 14px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.35);
  border-radius: 999px;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
  transition: transform 120ms ease, box-shadow 120ms ease;
}

.graph-note__swatch:hover {
  transform: scale(1.12);
}

.graph-note__swatch--active {
  border-color: #fff;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--on-surface) 62%, transparent);
}

.graph-note__font-size {
  width: 60px;
}

.graph-note__font-family {
  flex: 1;
  min-width: 88px;
}

.graph-note__color-dot--amber { background: rgb(245, 158, 11); }
.graph-note__color-dot--blue { background: rgb(59, 130, 246); }
.graph-note__color-dot--green { background: rgb(16, 185, 129); }
.graph-note__color-dot--rose { background: rgb(244, 63, 94); }

.graph-note__editable {
  cursor: text;
  border-radius: 6px;
  transition: background 120ms ease;
}

.graph-note__editable:hover {
  background: rgba(255, 255, 255, 0.06);
}

.graph-note__title--empty,
.graph-note__body--empty {
  color: color-mix(in srgb, var(--on-surface) 40%, transparent);
  font-weight: 500;
}

/* Inline editing fields are visually identical to the static text:
   fully transparent, borderless, no padding — cursor sits on the note. */
.graph-note__field {
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  letter-spacing: inherit;
  resize: none;
  overflow: hidden;
}

.graph-note__field::placeholder {
  color: color-mix(in srgb, var(--on-surface) 40%, transparent);
}

textarea.graph-note__field {
  display: block;
  min-height: 1.5em;
}

.node-context-menu {
  position: absolute;
  z-index: 16;
  display: grid;
  gap: 4px;
  min-width: 180px;
  padding: 8px;
  border-radius: 14px;
}

.node-context-menu button {
  border: 0;
  padding: 8px 10px;
  border-radius: 10px;
  background: transparent;
  color: var(--on-surface);
  text-align: left;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
}

.node-context-menu__label {
  padding: 4px 2px 6px;
  color: var(--on-surface-muted);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.node-context-menu button:hover {
  background: color-mix(in srgb, var(--primary-soft) 28%, var(--surface-1));
}

.node-context-menu button:disabled {
  opacity: 0.48;
  cursor: not-allowed;
}

.canvas-zoom-controls {
  position: absolute;
  left: 14px;
  bottom: 14px;
  z-index: 9;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 14px;
}

.canvas-zoom-controls strong {
  min-width: 48px;
  text-align: center;
  font-size: 12px;
}

.canvas-selection-controls {
  position: absolute;
  z-index: 9;
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 14px;
}

.canvas-selection-controls span {
  font-size: 12px;
  color: var(--on-surface-muted);
}

.canvas-minimap {
  position: absolute;
  right: 14px;
  bottom: 14px;
  z-index: 9;
  width: 196px;
  height: 132px;
  padding: 8px;
  border-radius: 16px;
  cursor: pointer;
}

.canvas-minimap svg {
  width: 100%;
  height: 100%;
  display: block;
  border-radius: 12px;
  overflow: hidden;
}

.minimap-bg {
  fill: color-mix(in srgb, var(--surface-2) 76%, transparent);
}

.minimap-node {
  opacity: 0.88;
}

.minimap-node--input {
  fill: rgba(34, 197, 94, 0.75);
}

.minimap-node--step {
  fill: color-mix(in srgb, var(--primary) 74%, white);
}

.minimap-node--save {
  fill: rgba(242, 201, 76, 0.82);
}

.minimap-node--utility {
  fill: rgba(96, 165, 250, 0.74);
}

.minimap-note {
  fill: rgba(245, 158, 11, 0.72);
}

.minimap-viewport {
  fill: rgba(255,255,255,0.06);
  stroke: color-mix(in srgb, var(--primary) 78%, white);
  stroke-width: 18;
}

.node-editor-footer {
  min-height: 50px;
  padding: 9px 14px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  border-top: 1px solid color-mix(in srgb, var(--outline) 60%, transparent);
  background: color-mix(in srgb, var(--surface-2) 52%, transparent);
}

.node-editor-footer > div {
  display: flex;
  gap: 10px;
}

.node-palette {
  display: grid;
  gap: 12px;
}

.node-palette__list {
  display: grid;
  gap: 8px;
}

.node-palette__item {
  border: 1px solid color-mix(in srgb, var(--outline) 46%, transparent);
  padding: 10px 12px;
  border-radius: 14px;
  display: grid;
  gap: 4px;
  background: color-mix(in srgb, var(--surface-2) 56%, transparent);
  color: var(--on-surface);
  text-align: left;
  cursor: pointer;
  font: inherit;
}

.node-palette__item:hover {
  border-color: color-mix(in srgb, var(--primary) 42%, var(--outline));
  background: color-mix(in srgb, var(--primary-soft) 22%, var(--surface-1));
}

.node-palette__item strong {
  font-size: 13px;
}

.node-palette__item span,
.node-palette__empty {
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
}

.node-config-form {
  display: grid;
  gap: 14px;
  max-height: min(72vh, 680px);
  overflow: auto;
  padding-right: 4px;
}

.node-config-form label {
  display: grid;
  gap: 8px;
}

.node-config-form label > span {
  color: var(--on-surface-muted);
  font-size: 12px;
  font-weight: 700;
}

.node-config-preview {
  display: grid;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 54%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--surface-2) 62%, transparent);
}

.node-config-preview__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.node-config-preview__actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.node-config-preview__head strong {
  font-size: 13px;
}

.node-config-preview__state,
.node-config-preview__stats {
  display: grid;
  gap: 4px;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
}

.node-config-preview__state--error {
  color: var(--error);
}

.node-config-preview__stats strong {
  color: var(--on-surface);
  font-size: 14px;
}

.node-config-preview__files {
  display: grid;
  gap: 6px;
}

.node-config-preview__files strong {
  color: var(--on-surface);
  font-size: 12px;
}

.node-config-preview__file-list {
  margin: 0;
  padding-left: 18px;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
}

.node-config-preview__file-list li {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.node-config-preview__warnings {
  margin: 0;
  padding-left: 18px;
  color: var(--on-surface-muted);
  font-size: 12px;
  line-height: 1.5;
}

.node-config-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.node-config-actions--secondary {
  padding-top: 4px;
}

.utility-weight-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}

.utility-weight-item {
  display: grid;
  gap: 6px;
}

.utility-weight-item strong {
  font-size: 11px;
  color: var(--on-surface-muted);
}

:deep(.node-config-modal) {
  max-width: calc(100vw - 32px);
}

:deep(.node-config-modal > .n-card) {
  border-radius: 20px;
}

:deep(.node-config-modal .n-card__content) {
  padding-top: 14px;
}

.json-error,
.json-ok {
  margin: 0;
  font-size: 12px;
}

.json-error {
  color: var(--danger);
}

.json-ok {
  color: var(--success);
}

:deep(.node-palette-modal) {
  width: min(520px, calc(100vw - 96px));
}

:deep(.node-palette-modal > .n-card) {
  border-radius: 18px;
  overflow: hidden;
}

:deep(.node-palette-modal .n-card__content) {
  min-height: 0;
  padding-top: 10px;
}

.node-palette {
  display: grid;
  gap: 12px;
}

.node-palette__list {
  max-height: min(56vh, 460px);
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  overflow: auto;
  padding-right: 4px;
  align-content: start;
}

.node-palette__item {
  min-height: 76px;
  padding: 12px;
  border: 1px solid color-mix(in srgb, var(--outline) 46%, transparent);
  border-radius: 14px;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.025), transparent 70%),
    color-mix(in srgb, var(--surface-1) 70%, transparent);
  display: grid;
  gap: 6px;
  text-align: left;
  transition: border-color 160ms ease, transform 160ms ease, background 160ms ease;
}

.node-palette__item:hover {
  border-color: color-mix(in srgb, var(--primary-strong) 48%, var(--outline));
  background:
    linear-gradient(180deg, rgba(255,255,255,0.04), transparent 70%),
    color-mix(in srgb, var(--surface-2) 76%, transparent);
  transform: translateY(-1px);
}

.node-palette__item strong {
  font-size: 13px;
  line-height: 1.25;
}

.node-palette__item span {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  color: var(--on-surface-muted);
  font-size: 11px;
  line-height: 1.45;
}

.node-palette__empty {
  grid-column: 1 / -1;
  min-height: 84px;
  display: grid;
  place-items: center;
  border: 1px dashed color-mix(in srgb, var(--outline) 56%, transparent);
  border-radius: 14px;
  color: var(--on-surface-muted);
  font-size: 12px;
}

@media (max-width: 720px) {
  .node-palette__list {
    grid-template-columns: minmax(0, 1fr);
    max-height: min(58vh, 420px);
  }
}

@media (max-width: 960px) {
  .canvas-minimap {
    display: none;
  }
}
</style>
