<script setup lang="ts">
import { computed } from 'vue'
import appLogoSymbol from '@/assets/app-logo-symbol-canvas.png'

const props = withDefaults(defineProps<{
  size?: number
  shadow?: boolean
  variant?: 'default' | 'hero' | 'compact'
}>(), {
  size: 32,
  shadow: false,
  variant: 'default',
})

const styleVars = computed(() => ({
  '--mark-size': `${props.size}px`,
}))
</script>

<template>
  <div
    class="app-brand-mark"
    :class="{ 'app-brand-mark--shadow': shadow }"
    :style="styleVars"
    :data-variant="variant"
    aria-hidden="true"
  >
    <span class="app-brand-mark__backdrop" />
    <img class="app-brand-mark__image" :src="appLogoSymbol" alt="App logo" />
  </div>
</template>

<style scoped>
.app-brand-mark {
  width: var(--mark-size);
  height: var(--mark-size);
  border-radius: calc(var(--mark-size) * 0.28);
  overflow: visible;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  position: relative;
  isolation: isolate;
}

.app-brand-mark--shadow {
  box-shadow:
    0 10px 28px rgba(17, 24, 39, 0.10),
    0 2px 8px rgba(17, 24, 39, 0.06);
}

.app-brand-mark__backdrop {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  z-index: 0;
  background:
    linear-gradient(180deg, rgba(255,255,255,0.14), rgba(255,255,255,0.03) 34%, transparent 100%),
    linear-gradient(180deg, color-mix(in srgb, var(--surface-1) 92%, white 8%), color-mix(in srgb, var(--surface-2) 95%, black 5%));
  border: 1px solid color-mix(in srgb, var(--outline) 88%, rgba(255,255,255,0.12));
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.08),
    inset 0 -1px 0 rgba(0,0,0,0.10);
}

.app-brand-mark__image {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
  display: block;
  object-fit: contain;
  padding: calc(var(--mark-size) * 0.10);
  filter:
    drop-shadow(0 1px 1px rgba(255,255,255,0.10))
    drop-shadow(0 8px 18px rgba(86, 118, 255, 0.12));
}

.app-brand-mark[data-variant='compact'] {
  border-radius: calc(var(--mark-size) * 0.26);
}

.app-brand-mark[data-variant='compact'] .app-brand-mark__image {
  padding: calc(var(--mark-size) * 0.08);
  filter:
    drop-shadow(0 1px 1px rgba(255,255,255,0.06))
    drop-shadow(0 5px 10px rgba(86, 118, 255, 0.10));
}

.app-brand-mark[data-variant='hero'] .app-brand-mark__image {
  padding: calc(var(--mark-size) * 0.115);
}

:global(.light-theme) .app-brand-mark__backdrop {
  background:
    linear-gradient(180deg, rgba(255,255,255,0.92), rgba(255,255,255,0.78) 36%, rgba(245,247,252,0.86) 100%),
    linear-gradient(180deg, #ffffff, #f4f7fc);
  border-color: rgba(17, 24, 39, 0.08);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.85),
    inset 0 -1px 0 rgba(17,24,39,0.04);
}

:global(.light-theme) .app-brand-mark[data-variant='hero'] .app-brand-mark__backdrop {
  background:
    linear-gradient(180deg, rgba(255,255,255,0.86), rgba(246,249,255,0.94) 42%, rgba(238,243,251,0.98) 100%),
    linear-gradient(180deg, #f9fbff, #eef3fb);
  border-color: rgba(92, 114, 164, 0.14);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.92),
    inset 0 -1px 0 rgba(109,123,160,0.06);
}

:global(.light-theme) .app-brand-mark[data-variant='hero'].app-brand-mark--shadow {
  box-shadow:
    0 8px 18px rgba(31, 41, 55, 0.08),
    0 2px 6px rgba(31, 41, 55, 0.05);
}

:global(.light-theme) .app-brand-mark[data-variant='compact'] .app-brand-mark__backdrop {
  background:
    linear-gradient(180deg, rgba(255,255,255,0.98), rgba(244,248,255,0.96) 42%, rgba(236,242,251,0.94) 100%),
    linear-gradient(180deg, #fbfcff, #eef3fa);
  border-color: rgba(92, 114, 164, 0.12);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.95),
    inset 0 -1px 0 rgba(109,123,160,0.05);
}

:global(.dark-theme) .app-brand-mark__backdrop {
  background:
    linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.02) 36%, transparent 100%),
    linear-gradient(180deg, #242a36, #1b202a);
  border-color: rgba(255,255,255,0.12);
  box-shadow:
    inset 0 1px 0 rgba(255,255,255,0.08),
    inset 0 -1px 0 rgba(0,0,0,0.20);
}

:global(.dark-theme) .app-brand-mark__image {
  filter:
    drop-shadow(0 1px 1px rgba(255,255,255,0.08))
    drop-shadow(0 10px 22px rgba(98, 126, 255, 0.18));
}

:global(.dark-theme) .app-brand-mark[data-variant='hero'].app-brand-mark--shadow {
  box-shadow:
    0 10px 22px rgba(0, 0, 0, 0.22),
    0 2px 8px rgba(0, 0, 0, 0.12);
}

:global(.dark-theme) .app-brand-mark[data-variant='compact'] .app-brand-mark__backdrop {
  background:
    linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.015) 36%, transparent 100%),
    linear-gradient(180deg, #2a303c, #202530);
  border-color: rgba(255,255,255,0.10);
}

:global(.dark-theme) .app-brand-mark[data-variant='compact'] .app-brand-mark__image {
  filter:
    drop-shadow(0 1px 1px rgba(255,255,255,0.06))
    drop-shadow(0 7px 14px rgba(98, 126, 255, 0.14));
}
</style>
