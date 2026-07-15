import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isWorkflowEditorSurfaceLocked,
  isWorkflowLockedByNodeEditor,
} from '../src/utils/workflowEditorState.ts'

test('only locks the workflow opened in the node editor', () => {
  assert.equal(isWorkflowLockedByNodeEditor('', 'workflow-a'), false)
  assert.equal(isWorkflowLockedByNodeEditor('workflow-a', 'workflow-a'), true)
  assert.equal(isWorkflowLockedByNodeEditor('workflow-a', 'workflow-b'), false)
  assert.equal(isWorkflowLockedByNodeEditor('__new__', 'workflow-a'), false)
})

test('locks a new simple draft only for its new node editor', () => {
  assert.equal(isWorkflowEditorSurfaceLocked('__new__', 'workflow-a', true), true)
  assert.equal(isWorkflowEditorSurfaceLocked('workflow-a', 'workflow-a', true), false)
  assert.equal(isWorkflowEditorSurfaceLocked('workflow-a', 'workflow-a', false), true)
})
