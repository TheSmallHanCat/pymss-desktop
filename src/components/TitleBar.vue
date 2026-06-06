<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { getCurrentWindow } from '@tauri-apps/api/window'
import AppBrandMark from '@/components/AppBrandMark.vue'
import { useSettingsStore } from '@/stores/settings'

const route = useRoute()
const { t } = useI18n()
const message = useMessage()
const settings = useSettingsStore()
const hasTauriWindow = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
const appWindow = hasTauriWindow ? getCurrentWindow() : null
const isMaximized = ref(false)

const pageTitle = computed(() => t(`nav.${String(route.name || 'home')}`))
const closeDisabled = computed(() => settings.isModelDirMigrating)

async function refreshMaximized() {
  if (!appWindow) { isMaximized.value = false; return }
  try { isMaximized.value = await appWindow.isMaximized() } catch { isMaximized.value = false }
}
function minimize() { appWindow?.minimize().catch(() => {}) }
function toggleMaximize() { appWindow?.toggleMaximize().then(refreshMaximized).catch(() => {}) }
function close() {
  if (closeDisabled.value) {
    message.warning(t('settings.modelDirMigrationCloseBlocked'))
    return
  }
  appWindow?.close().catch(() => {})
}
function startDrag(event: MouseEvent) {
  if (event.detail > 1) { toggleMaximize(); return }
  appWindow?.startDragging().catch(() => {})
}

let unlistenResize: (() => void) | undefined
let unlistenCloseRequested: (() => void) | undefined
onMounted(async () => {
  await refreshMaximized()
  if (!appWindow) return
  try { unlistenResize = await appWindow.onResized(refreshMaximized) } catch {}
  try {
    unlistenCloseRequested = await appWindow.onCloseRequested((event) => {
      if (!closeDisabled.value) return
      event.preventDefault()
      message.warning(t('settings.modelDirMigrationCloseBlocked'))
    })
  } catch {}
})
onUnmounted(() => {
  unlistenResize?.()
  unlistenCloseRequested?.()
})
</script>

<template>
  <header class="title-bar">
    <div class="title-brand" @mousedown.left="startDrag">
      <AppBrandMark :size="22" variant="compact" />
      <div class="brand-copy">
        <strong>{{ t('app.name') }}</strong>
        <span>{{ pageTitle }}</span>
      </div>
    </div>
    <div class="title-drag-space" @mousedown.left="startDrag" />
    <div class="window-actions" @mousedown.stop>
      <button type="button" :aria-label="t('common.minimize')" @click="minimize">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2 6h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
      <button type="button" :aria-label="t('common.maximize')" @click="toggleMaximize">
        <svg v-if="isMaximized" width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1.5" y="3.5" width="7" height="7" rx="1" stroke="currentColor" stroke-width="1.2"/><path d="M3.5 3.5V2a.5.5 0 01.5-.5h6a.5.5 0 01.5.5v6a.5.5 0 01-.5.5h-1.5" stroke="currentColor" stroke-width="1.2"/></svg>
        <svg v-else width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="2" y="2" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/></svg>
      </button>
      <button type="button" :aria-label="t('common.close')" class="danger" :disabled="closeDisabled" @click="close">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
    </div>
  </header>
</template>
