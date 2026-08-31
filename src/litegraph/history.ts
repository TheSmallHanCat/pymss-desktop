export const WORKFLOW_HISTORY_LIMIT = 50

export type WorkflowHistory = {
  past: string[]
  current: string
  future: string[]
}

export type WorkflowHistoryStep = {
  history: WorkflowHistory
  snapshot: string | null
}

export type WorkflowHistoryShortcut = 'undo' | 'redo' | null

export function createWorkflowHistory(current = ''): WorkflowHistory {
  return { past: [], current, future: [] }
}

export function recordWorkflowSnapshot(
  history: WorkflowHistory,
  snapshot: string,
  limit = WORKFLOW_HISTORY_LIMIT,
): WorkflowHistory {
  if (!snapshot || snapshot === history.current) return history
  if (!history.current) return createWorkflowHistory(snapshot)
  return {
    past: [...history.past, history.current].slice(-limit),
    current: snapshot,
    future: [],
  }
}

export function undoWorkflowHistory(
  history: WorkflowHistory,
  limit = WORKFLOW_HISTORY_LIMIT,
): WorkflowHistoryStep {
  const previous = history.past.at(-1)
  if (!previous) return { history, snapshot: null }
  return {
    history: {
      past: history.past.slice(0, -1),
      current: previous,
      future: [history.current, ...history.future].slice(0, limit),
    },
    snapshot: previous,
  }
}

export function redoWorkflowHistory(
  history: WorkflowHistory,
  limit = WORKFLOW_HISTORY_LIMIT,
): WorkflowHistoryStep {
  const next = history.future[0]
  if (!next) return { history, snapshot: null }
  return {
    history: {
      past: [...history.past, history.current].slice(-limit),
      current: next,
      future: history.future.slice(1),
    },
    snapshot: next,
  }
}

export function replaceWorkflowHistoryCurrent(
  history: WorkflowHistory,
  current: string,
): WorkflowHistory {
  return { ...history, current }
}

export function resolveWorkflowHistoryShortcut(
  event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'key'>,
): WorkflowHistoryShortcut {
  if (!event.ctrlKey && !event.metaKey) return null
  const key = event.key.toLowerCase()
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo'
  if (key === 'y') return 'redo'
  return null
}
