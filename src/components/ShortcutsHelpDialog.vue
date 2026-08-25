<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useFocusTrap } from '@/composables/useFocusTrap'

/**
 * ShortcutsHelpDialog — modal reference of every keyboard shortcut.
 *
 * Rendered through `<n-modal>` (portal + mask + transition) but focus
 * containment, initial focus, and Esc-to-close are owned by `useFocusTrap`
 * so the dialog behaves consistently with the rest of the a11y layer.
 * n-modal's own auto-focus and close-on-esc are disabled to avoid fighting
 * the trap.
 *
 * Opened globally from App.vue via the `?` key.
 */
const show = defineModel<boolean>('show', { default: false })

const dialogRef = ref<HTMLElement | null>(null)
const trap = useFocusTrap(dialogRef, {
  onEsc: () => {
    show.value = false
  },
})

watch(show, async (visible) => {
  if (visible) {
    // n-modal teleports its content; wait for the DOM to settle before
    // activating the trap so the container ref is populated.
    await nextTick()
    trap.trap()
  } else {
    trap.release()
  }
})

interface ShortcutRow {
  key: string
  action: string
}

const editorShortcuts: ShortcutRow[] = [
  { key: 'Space', action: 'Play / Pause' },
  { key: 'Escape', action: 'Stop playback' },
  { key: 'Delete / Backspace', action: 'Remove the selected track' },
  { key: 'M', action: 'Toggle mute on the selected track' },
  { key: 'R', action: 'Toggle solo on the selected track' },
  { key: 'Home', action: 'Move the playhead to the start' },
  { key: '+ / =', action: 'Zoom in' },
  { key: '- / _', action: 'Zoom out' },
  { key: 'ArrowLeft', action: 'Seek backward 1 second' },
  { key: 'ArrowRight', action: 'Seek forward 1 second' },
  { key: 'Shift + ArrowLeft', action: 'Seek backward 5 seconds' },
  { key: 'Shift + ArrowRight', action: 'Seek forward 5 seconds' },
  { key: 'Ctrl + S', action: 'Save the project' },
  { key: 'Ctrl + Z', action: 'Undo' },
  { key: 'Ctrl + Shift + Z / Ctrl + Y', action: 'Redo' },
]

const globalShortcuts: ShortcutRow[] = [
  { key: 'Tab', action: 'Move focus to the next focusable element' },
  { key: '?', action: 'Open this keyboard shortcuts help' },
  { key: 'Escape', action: 'Close this dialog' },
]

/** Split a "A / B" key cell into individual <kbd> segments. */
function splitKeys(value: string): string[] {
  return value.split(' / ')
}

function close() {
  show.value = false
}
</script>

<template>
  <n-modal
    v-model:show="show"
    :auto-focus="false"
    :close-on-esc="false"
    :mask-closable="true"
    :bordered="false"
    class="shortcuts-help-modal"
  >
    <div
      ref="dialogRef"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      class="shortcuts-help"
    >
      <header class="shortcuts-help__header">
        <h2 class="shortcuts-help__title">Keyboard shortcuts</h2>
        <n-button
          class="shortcuts-help__close"
          quaternary
          circle
          aria-label="Close dialog"
          @click="close"
        >
          ×
        </n-button>
      </header>

      <div class="shortcuts-help__body">
        <table class="shortcuts-table">
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            <tr class="shortcuts-table__group">
              <th colspan="2" scope="rowgroup">Editor</th>
            </tr>
            <tr v-for="(row, index) in editorShortcuts" :key="`editor-${index}`">
              <td class="shortcuts-table__key">
                <template v-for="(part, partIndex) in splitKeys(row.key)" :key="partIndex">
                  <kbd>{{ part }}</kbd>
                  <span v-if="partIndex < splitKeys(row.key).length - 1" class="shortcuts-table__sep"> / </span>
                </template>
              </td>
              <td>{{ row.action }}</td>
            </tr>
          </tbody>
          <tbody>
            <tr class="shortcuts-table__group">
              <th colspan="2" scope="rowgroup">Global</th>
            </tr>
            <tr v-for="(row, index) in globalShortcuts" :key="`global-${index}`">
              <td class="shortcuts-table__key">
                <template v-for="(part, partIndex) in splitKeys(row.key)" :key="partIndex">
                  <kbd>{{ part }}</kbd>
                  <span v-if="partIndex < splitKeys(row.key).length - 1" class="shortcuts-table__sep"> / </span>
                </template>
              </td>
              <td>{{ row.action }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <footer class="shortcuts-help__footer">
        <n-button type="primary" @click="close">Close</n-button>
      </footer>
    </div>
  </n-modal>
</template>

<style scoped>
.shortcuts-help-modal {
  width: min(640px, calc(100vw - 32px));
}

.shortcuts-help {
  width: min(640px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow: auto;
  background: var(--surface, #ffffff);
  color: var(--on-surface, #1f2329);
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
  padding: 20px 24px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.shortcuts-help__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.shortcuts-help__title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}

.shortcuts-help__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.shortcuts-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.shortcuts-table th,
.shortcuts-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--on-surface, #1f2329) 12%, transparent);
  vertical-align: top;
}

.shortcuts-table thead th {
  font-weight: 600;
  color: var(--on-surface-muted, #6b7280);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.shortcuts-table__group th {
  font-weight: 600;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--on-surface-muted, #6b7280);
  background: color-mix(in srgb, var(--on-surface, #1f2329) 4%, transparent);
  padding-top: 10px;
  padding-bottom: 10px;
}

.shortcuts-table__key {
  white-space: nowrap;
  width: 1%;
}

.shortcuts-table kbd {
  display: inline-block;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1;
  padding: 4px 6px;
  border-radius: 5px;
  border: 1px solid color-mix(in srgb, var(--on-surface, #1f2329) 20%, transparent);
  background: color-mix(in srgb, var(--on-surface, #1f2329) 6%, transparent);
  color: var(--on-surface, #1f2329);
}

.shortcuts-table__sep {
  color: var(--on-surface-muted, #6b7280);
}

.shortcuts-help__footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
}
</style>
