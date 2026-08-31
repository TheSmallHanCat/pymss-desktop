<script setup lang="ts">
import type { AudioToolKey, AudioToolResult } from '../types'
import AudioToolStatus from '@/components/tools/AudioToolStatus.vue'
import { useAudioToolRuntime } from '../runtime'

const props = withDefaults(defineProps<{
  tool: AudioToolKey
  statusTitle: string
  statusHint: string
  layout?: 'split' | 'stacked'
}>(), {
  layout: 'split',
})
const runtime = useAudioToolRuntime()
const state = runtime.stateFor(props.tool)
</script>

<template>
  <div
    class="audio-tool-layout"
    :class="{ 'audio-tool-layout--stacked': layout === 'stacked' }"
  >
    <section class="audio-tool-card audio-tool-card--main">
      <slot :state="state" />
    </section>
    <aside class="audio-tool-card audio-tool-card--side">
      <h3>{{ statusTitle }}</h3>
      <p>{{ statusHint }}</p>
      <AudioToolStatus
        :busy="state.busy"
        :cancelling="state.cancelling"
        :has-result="state.hasResult"
        :error="state.error"
        :progress="state.progress"
        :percentage="state.percentage"
        :result="state.result"
        :elapsed-ms="state.elapsedMs"
        :logs="state.logs"
        @cancel="runtime.cancel"
        @reveal="runtime.revealPath"
      >
        <template v-if="$slots.result" #result="slotProps: { result: AudioToolResult }">
          <slot name="result" :result="slotProps.result" />
        </template>
      </AudioToolStatus>
    </aside>
  </div>
</template>
