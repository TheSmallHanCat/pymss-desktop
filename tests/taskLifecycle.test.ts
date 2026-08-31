import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isInterruptedTaskStatus,
  resolveJobStatus,
  selectQueuedJobGroups,
  type TaskLifecycleItem,
  type TaskStatus,
} from '../src/features/tasks/lifecycle.ts'

function task(id: string, status: TaskStatus, jobId = id, createdAt = 1): TaskLifecycleItem {
  return { id, jobId, status, createdAt }
}

describe('task job lifecycle', () => {
  it('keeps queued work resumable while marking active stages interrupted', () => {
    assert.equal(isInterruptedTaskStatus('queued'), false)
    assert.equal(isInterruptedTaskStatus('separating'), true)
  })

  it('does not report queued jobs as running', () => {
    assert.equal(resolveJobStatus([task('a', 'queued'), task('b', 'queued')]), 'queued')
    assert.equal(resolveJobStatus([task('a', 'done'), task('b', 'queued')]), 'queued')
  })

  it('reports mixed terminal results without hiding failures or cancellations', () => {
    assert.equal(resolveJobStatus([task('a', 'done'), task('b', 'failed')]), 'failed')
    assert.equal(resolveJobStatus([task('a', 'done'), task('b', 'cancelled')]), 'cancelled')
    assert.equal(resolveJobStatus([task('a', 'failed'), task('b', 'cancelled')]), 'failed')
    assert.equal(resolveJobStatus([task('a', 'done'), task('b', 'done')]), 'done')
  })

  it('uses the most advanced active stage for a running job', () => {
    assert.equal(resolveJobStatus([task('a', 'preparing'), task('b', 'queued')]), 'preparing')
    assert.equal(resolveJobStatus([task('a', 'loading_model'), task('b', 'separating')]), 'separating')
    assert.equal(resolveJobStatus([task('a', 'separating'), task('b', 'writing_output')]), 'writing_output')
  })
})

describe('Worker-slot queue selection', () => {
  it('counts a multi-task batch as one active Worker', () => {
    const tasks = [
      task('active-a', 'separating', 'active', 1),
      task('active-b', 'preparing', 'active', 2),
      task('next-a', 'queued', 'next', 3),
      task('next-b', 'queued', 'next', 4),
    ]

    assert.deepEqual(selectQueuedJobGroups(tasks, 1), [])
    assert.deepEqual(selectQueuedJobGroups(tasks, 2).map(group => group.map(item => item.id)), [
      ['next-a', 'next-b'],
    ])
  })

  it('selects complete queued jobs in submission order', () => {
    const tasks = [
      task('batch-a', 'queued', 'batch', 1),
      task('batch-b', 'queued', 'batch', 2),
      task('single', 'queued', 'single', 3),
      task('later', 'queued', 'later', 4),
    ]

    assert.deepEqual(selectQueuedJobGroups(tasks, 2).map(group => group.map(item => item.id)), [
      ['batch-a', 'batch-b'],
      ['single'],
    ])
  })

  it('does not start queued children of an already active job', () => {
    const tasks = [
      task('active', 'separating', 'batch', 1),
      task('same-job', 'queued', 'batch', 2),
      task('other', 'queued', 'other', 3),
    ]

    assert.deepEqual(selectQueuedJobGroups(tasks, 2).map(group => group.map(item => item.id)), [['other']])
  })
})
