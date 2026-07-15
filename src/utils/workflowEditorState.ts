export function isWorkflowLockedByNodeEditor(openWorkflowId: string, workflowId: string) {
  const openId = openWorkflowId.trim()
  const currentId = workflowId.trim()
  return Boolean(openId && currentId && openId === currentId)
}

export function isWorkflowEditorSurfaceLocked(
  openWorkflowId: string,
  workflowId: string,
  editingNewWorkflow: boolean,
) {
  const openId = openWorkflowId.trim()
  if (editingNewWorkflow) return openId === '__new__'
  return isWorkflowLockedByNodeEditor(openId, workflowId)
}
