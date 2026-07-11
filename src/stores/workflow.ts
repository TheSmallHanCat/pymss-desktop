import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { loadAppStore, saveAppStore } from '@/utils/appStore'
import { normalizeWorkflowDefinition } from '@/utils/workflowGraph'

export type WorkflowEntry = {
  id: string
  name: string
  description: string
  definition: Record<string, unknown>
  createdAt: number
  updatedAt: number
}

type StoredWorkflowState = {
  workflows?: Partial<WorkflowEntry>[]
  selectedWorkflowId?: string
}

function createId(prefix = 'workflow') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeDefinition(value: unknown): Record<string, unknown> {
  return normalizeWorkflowDefinition(
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {},
  )
}

function normalizeWorkflow(input: Partial<WorkflowEntry>): WorkflowEntry | null {
  const name = String(input.name || '').trim()
  const id = String(input.id || '').trim() || createId()
  if (!name) return null
  const now = Date.now()
  return {
    id,
    name,
    description: String(input.description || '').trim(),
    definition: normalizeDefinition(input.definition),
    createdAt: Number.isFinite(Number(input.createdAt)) ? Number(input.createdAt) : now,
    updatedAt: Number.isFinite(Number(input.updatedAt)) ? Number(input.updatedAt) : now,
  }
}

export const useWorkflowStore = defineStore('workflow', () => {
  const workflows = ref<WorkflowEntry[]>([])
  const selectedWorkflowId = ref('')
  const nodeEditorOpenWorkflowId = ref('')
  const initialized = ref(false)
  const isSaving = ref(false)
  const selectedWorkflow = computed(() => workflows.value.find(item => item.id === selectedWorkflowId.value) || null)

  async function persist() {
    isSaving.value = true
    try {
      await saveAppStore('workflow-state', {
        workflows: workflows.value,
        selectedWorkflowId: selectedWorkflowId.value,
      })
    } finally {
      isSaving.value = false
    }
  }

  async function loadStoredState() {
    const stored = await loadAppStore<StoredWorkflowState>('workflow-state').catch(() => null)
    workflows.value = (stored?.workflows || [])
      .map(item => normalizeWorkflow(item))
      .filter((item): item is WorkflowEntry => Boolean(item))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    selectedWorkflowId.value = String(stored?.selectedWorkflowId || '')
    if (!workflows.value.some(item => item.id === selectedWorkflowId.value)) {
      selectedWorkflowId.value = workflows.value[0]?.id || ''
    }
    initialized.value = true
  }

  async function initialize() {
    if (initialized.value) return
    await loadStoredState()
  }

  async function reload() {
    await loadStoredState()
  }

  async function saveWorkflow(input: {
    id?: string
    name: string
    description?: string
    definition: Record<string, unknown>
  }) {
    const now = Date.now()
    const existing = input.id ? workflows.value.find(item => item.id === input.id) : null
    const entry: WorkflowEntry = {
      id: existing?.id || input.id || createId(),
      name: input.name.trim(),
      description: String(input.description || '').trim(),
      definition: normalizeDefinition(input.definition),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    }
    if (!entry.name) throw new Error('Workflow name is required')
    const index = workflows.value.findIndex(item => item.id === entry.id)
    if (index >= 0) workflows.value.splice(index, 1, entry)
    else workflows.value.unshift(entry)
    workflows.value.sort((a, b) => b.updatedAt - a.updatedAt)
    selectedWorkflowId.value = entry.id
    await persist()
    return entry
  }

  async function deleteWorkflow(id: string) {
    workflows.value = workflows.value.filter(item => item.id !== id)
    if (selectedWorkflowId.value === id) selectedWorkflowId.value = workflows.value[0]?.id || ''
    if (nodeEditorOpenWorkflowId.value === id) nodeEditorOpenWorkflowId.value = ''
    await persist()
  }

  async function duplicateWorkflow(id: string) {
    const source = workflows.value.find(item => item.id === id)
    if (!source) return null
    return saveWorkflow({
      name: `${source.name} Copy`,
      description: source.description,
      definition: JSON.parse(JSON.stringify(source.definition)) as Record<string, unknown>,
    })
  }

  function selectWorkflow(id: string) {
    selectedWorkflowId.value = workflows.value.some(item => item.id === id) ? id : ''
    void persist()
  }

  function markNodeEditorOpen(workflowId: string) {
    nodeEditorOpenWorkflowId.value = workflowId
  }

  function markNodeEditorClosed() {
    nodeEditorOpenWorkflowId.value = ''
  }

  return {
    workflows,
    selectedWorkflowId,
    nodeEditorOpenWorkflowId,
    selectedWorkflow,
    initialized,
    isSaving,
    initialize,
    reload,
    saveWorkflow,
    deleteWorkflow,
    duplicateWorkflow,
    selectWorkflow,
    markNodeEditorOpen,
    markNodeEditorClosed,
  }
})
