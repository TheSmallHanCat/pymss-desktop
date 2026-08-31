export type TaskStatus =
  | 'queued'
  | 'preparing'
  | 'validating_input'
  | 'downloading_model'
  | 'ensuring_model'
  | 'loading_model'
  | 'separating'
  | 'writing_output'
  | 'done'
  | 'failed'
  | 'cancelled'

export const TERMINAL_TASK_STATUSES = ['done', 'failed', 'cancelled'] as const satisfies readonly TaskStatus[]

// Queued work has not been handed to a Worker yet and can safely resume after
// an application restart. Only stages that require an active Worker are
// considered interrupted when persisted state is restored.
export const INTERRUPTIBLE_TASK_STATUSES = [
  'preparing',
  'validating_input',
  'downloading_model',
  'ensuring_model',
  'loading_model',
  'separating',
  'writing_output',
] as const satisfies readonly TaskStatus[]

const ACTIVE_STATUS_PRIORITY: readonly TaskStatus[] = [
  'writing_output',
  'separating',
  'loading_model',
  'ensuring_model',
  'downloading_model',
  'validating_input',
  'preparing',
]

export type TaskLifecycleItem = {
  id: string
  jobId?: string
  batchId?: string
  createdAt: number
  status: TaskStatus
}

export function isTerminalTaskStatus(status: TaskStatus) {
  return TERMINAL_TASK_STATUSES.includes(status as (typeof TERMINAL_TASK_STATUSES)[number])
}

export function isInterruptedTaskStatus(status: TaskStatus) {
  return INTERRUPTIBLE_TASK_STATUSES.includes(status as (typeof INTERRUPTIBLE_TASK_STATUSES)[number])
}

export function taskJobId(task: Pick<TaskLifecycleItem, 'id' | 'jobId' | 'batchId'>) {
  return task.jobId || task.batchId || task.id
}

/** Resolves a job state without reporting queued work as running or partial failure as success. */
export function resolveJobStatus(items: readonly Pick<TaskLifecycleItem, 'status'>[]): TaskStatus {
  if (!items.length) return 'queued'

  for (const status of ACTIVE_STATUS_PRIORITY) {
    if (items.some(item => item.status === status)) return status
  }
  if (items.some(item => item.status === 'queued')) return 'queued'
  if (items.every(item => item.status === 'done')) return 'done'
  if (items.some(item => item.status === 'failed')) return 'failed'
  if (items.some(item => item.status === 'cancelled')) return 'cancelled'
  return 'done'
}

/** Selects queued jobs for available Worker slots; one batch occupies one slot. */
export function selectQueuedJobGroups<T extends TaskLifecycleItem>(
  tasks: readonly T[],
  maxConcurrentWorkers: number,
): T[][] {
  const limit = Math.max(1, Math.trunc(Number(maxConcurrentWorkers) || 1))
  const activeJobIds = new Set(
    tasks
      .filter(task => task.status !== 'queued' && !isTerminalTaskStatus(task.status))
      .map(taskJobId),
  )
  const available = limit - activeJobIds.size
  if (available <= 0) return []

  const groups = new Map<string, T[]>()
  ;[...tasks]
    .filter(task => task.status === 'queued' && !activeJobIds.has(taskJobId(task)))
    .sort((left, right) => left.createdAt - right.createdAt)
    .forEach((task) => {
      const id = taskJobId(task)
      const group = groups.get(id)
      if (group) group.push(task)
      else groups.set(id, [task])
    })

  return [...groups.values()].slice(0, available)
}
