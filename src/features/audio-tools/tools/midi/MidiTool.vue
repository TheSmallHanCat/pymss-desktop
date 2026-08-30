<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-shell'
import { useI18n } from 'vue-i18n'
import { useMessage } from 'naive-ui'
import { CloudDownloadOutline, DocumentOutline, FolderOpenOutline, MusicalNoteOutline } from '@vicons/ionicons5'
import { useSettingsStore } from '@/stores/settings'
import AudioToolPanel from '../../shared/AudioToolPanel.vue'
import AudioToolHeader from '../../shared/AudioToolHeader.vue'
import { useAudioToolRuntime } from '../../runtime'
import { loadAudioToolsState, updateAudioToolsState } from '../../state'
const GAME_URL = 'https://github.com/openvpi/GAME/releases/tag/v1.0.0'
type Language = '' | 'zh' | 'yue' | 'ja' | 'en'
const { t } = useI18n(); const message = useMessage(); const settings = useSettingsStore(); const runtime = useAudioToolRuntime(); const state = runtime.stateFor('midi')
const inputPath = ref(''); const modelPath = ref(''); const outputDir = ref(settings.outputDir); const bpm = ref<number | null>(120); const language = ref<Language>(''); let restored = false
const languages = computed(() => [{ label: t('tools.midiLanguageAuto'), value: '' }, { label: t('tools.midiLanguageChinese'), value: 'zh' }, { label: t('tools.midiLanguageCantonese'), value: 'yue' }, { label: t('tools.midiLanguageJapanese'), value: 'ja' }, { label: t('tools.midiLanguageEnglish'), value: 'en' }])
const validBpm = computed(() => typeof bpm.value === 'number' && Number.isFinite(bpm.value) && bpm.value >= 30 && bpm.value <= 300)
const looksLikeAccompaniment = computed(() => /(?:instrumental|accompaniment|no[_ -]?vocals?|伴奏|无人声)/i.test(fileName(inputPath.value)))
function fileName(path: string) { return path.split(/[\\/]/).filter(Boolean).pop() || path }
async function pickAudio() { const path = await invoke<string | null>('pick_single_audio_file'); if (path) inputPath.value = path }
async function pickOutput() { const path = await invoke<string | null>('pick_output_folder'); if (path) outputDir.value = path }
async function pickModel() { const path = await invoke<string | null>('pick_model_weights_file', { title: t('tools.midiModelPickerTitle') }); if (!path) return; if (!path.toLowerCase().endsWith('.pt')) return void message.error(t('tools.midiModelExtensionError')); modelPath.value = path }
async function openRelease() { try { if (typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window)) window.open(GAME_URL, '_blank', 'noopener,noreferrer'); else await open(GAME_URL) } catch (error) { message.error(String(error)) } }
function run() { if (!validBpm.value) return; void runtime.execute('midi', { inputPath: inputPath.value, modelPath: modelPath.value, outputDir: outputDir.value, bpm: bpm.value, language: language.value }) }
onMounted(async () => { const saved = await loadAudioToolsState(); if (saved?.midiModelPath?.toLowerCase().endsWith('.pt')) modelPath.value = saved.midiModelPath; if (['', 'zh', 'yue', 'ja', 'en'].includes(saved?.midiLanguage || '')) language.value = (saved?.midiLanguage || '') as Language; restored = true })
watch([modelPath, language], () => { if (restored) void updateAudioToolsState({ midiModelPath: modelPath.value, midiLanguage: language.value }) })
watch(() => settings.outputDir, value => { if (!outputDir.value) outputDir.value = value })
</script>
<template><AudioToolPanel tool="midi" :status-title="t('tools.processingStatus')" :status-hint="t('tools.midiHint')">
  <AudioToolHeader :icon="MusicalNoteOutline" :title="t('tools.midiTitle')" :description="t('tools.midiDescription')" />
  <div class="audio-tool-field"><label>{{ t('tools.vocalAudio') }}</label><div class="audio-tool-path"><n-input :value="inputPath" readonly :placeholder="t('tools.chooseVocalAudio')" /><n-button secondary :disabled="state.anyBusy" @click="pickAudio"><template #icon><n-icon :component="DocumentOutline" /></template>{{ t('common.browse') }}</n-button></div><n-alert v-if="looksLikeAccompaniment" class="audio-tool-inline-alert" type="warning" :bordered="false">{{ t('tools.midiInputLooksLikeAccompaniment') }}</n-alert></div>
  <div class="audio-tool-field"><div class="audio-tool-field-heading"><label>{{ t('tools.midiModel') }}</label><a :href="GAME_URL" target="_blank" rel="noopener noreferrer" @click.prevent="openRelease"><n-icon :component="CloudDownloadOutline" />{{ t('tools.midiModelDownload') }}</a></div><button class="audio-tool-model-picker" :class="{ selected: modelPath }" :disabled="state.anyBusy" @click="pickModel"><n-icon :component="DocumentOutline" size="21" /><span><strong>{{ modelPath ? fileName(modelPath) : t('tools.chooseMidiModel') }}</strong><small :title="modelPath">{{ modelPath || t('tools.midiModelChooseHint') }}</small></span><em>{{ modelPath ? t('tools.reselectModel') : t('common.browse') }}</em></button><small class="audio-tool-hint">{{ t('tools.midiModelHint') }}</small></div>
  <div class="audio-tool-grid"><div class="audio-tool-field"><label>{{ t('tools.bpm') }}</label><n-input-number v-model:value="bpm" :min="30" :max="300" :disabled="state.anyBusy" /></div><div class="audio-tool-field"><label>{{ t('tools.midiLanguage') }}</label><n-select v-model:value="language" :options="languages" :disabled="state.anyBusy" /></div></div>
  <div class="audio-tool-field"><label>{{ t('tools.outputDirectory') }}</label><div class="audio-tool-path"><n-input :value="outputDir" readonly /><n-button secondary :disabled="state.anyBusy" @click="pickOutput"><template #icon><n-icon :component="FolderOpenOutline" /></template>{{ t('common.browse') }}</n-button></div></div>
  <n-alert type="warning" :bordered="false">{{ t('tools.midiAccuracyHint') }}</n-alert>
  <div class="audio-tool-actions"><n-button type="primary" :loading="state.busy" :disabled="state.anyBusy || !inputPath || !modelPath || !outputDir || !validBpm" @click="run">{{ t('tools.startMidi') }}</n-button></div>
</AudioToolPanel></template>
