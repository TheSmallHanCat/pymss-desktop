<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { audioTools } from '@/features/audio-tools/registry'
import { audioToolRuntimeKey, createAudioToolRuntime } from '@/features/audio-tools/runtime'
import { loadAudioToolsState, updateAudioToolsState } from '@/features/audio-tools/state'
import type { AudioToolCategory, AudioToolKey } from '@/features/audio-tools/types'
defineOptions({ name: 'ToolsView' })
const { t } = useI18n()
const runtime = createAudioToolRuntime()
provide(audioToolRuntimeKey, runtime)
const activeTool = ref<AudioToolKey>('convert')
const activeDefinition = computed(() => audioTools.find(tool => tool.id === activeTool.value) || audioTools[0])
const mobileToolOptions = computed(() => audioTools
  .filter(tool => !tool.hidden)
  .map(tool => ({ label: t(tool.titleKey), value: tool.id })))
const categories: Array<{ id: AudioToolCategory; titleKey: string }> = [
  { id: 'convert', titleKey: 'tools.categoryConvert' },
  { id: 'analyze', titleKey: 'tools.categoryAnalyze' },
  { id: 'recognize', titleKey: 'tools.categoryRecognize' },
  { id: 'edit', titleKey: 'tools.categoryEdit' },
]
const toolsByCategory = (category: AudioToolCategory) => audioTools.filter(tool => tool.category === category && !tool.hidden)
let restored = false
onMounted(async () => { const stored = await loadAudioToolsState(); if (stored?.activeTool && audioTools.some(tool => tool.id === stored.activeTool && !tool.hidden)) activeTool.value = stored.activeTool; restored = true; await runtime.start() })
onUnmounted(() => runtime.stop())
watch(activeTool, value => { if (restored) void updateAudioToolsState({ activeTool: value }) })
</script>
<template><div class="page tools-page audio-tools-page"><div class="page-header-compact"><div><h1>{{ t('tools.title') }}</h1><p>{{ t('tools.subtitle') }}</p></div></div>
  <n-select v-model:value="activeTool" class="audio-tools-mobile-select" :options="mobileToolOptions" />
  <div class="audio-tools-workspace"><nav class="audio-tools-nav" :aria-label="t('tools.toolNavigation')"><section v-for="category in categories" :key="category.id"><strong>{{ t(category.titleKey) }}</strong><button v-for="tool in toolsByCategory(category.id)" :key="tool.id" type="button" :class="{ active: activeTool === tool.id }" @click="activeTool = tool.id"><n-icon :component="tool.icon" /><span>{{ t(tool.titleKey) }}</span></button></section></nav>
    <main class="audio-tools-content"><KeepAlive><component :is="activeDefinition.component" :key="activeDefinition.id" /></KeepAlive></main>
  </div>
</div></template>
<style src="@/features/audio-tools/styles.css"></style>
