<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { LIVE_REGION_IDS } from '@/composables/useLiveAnnouncer'

const { t } = useI18n()

/**
 * A11yProvider — mounts the global screen-reader infrastructure:
 *   1. A skip-to-content link (the first focusable element on every page) so
 *      keyboard users can bypass the sidebar.
 *   2. Two visually-hidden `aria-live` regions (polite / assertive) that
 *      `useLiveAnnouncer` writes announcements into.
 *
 * The `<main id="main-content" tabindex="-1">` target lives in App.vue; this
 * component only needs to know its id so the skip link can point at it.
 */
const MAIN_CONTENT_ID = 'main-content'
</script>

<template>
  <!-- Skip link: visually hidden until focused (see .skip-link in global.scss).
       Must be the first focusable element so a single Tab reaches it. -->
  <a
    :href="`#${MAIN_CONTENT_ID}`"
    class="skip-link"
  >
    {{ t('a11y.skipToContent') }}
  </a>

  <!-- Live regions: visually hidden but readable by screen readers.
       aria-hidden is intentionally NOT set — that would silence them.
       They are clipped off-screen instead. -->
  <div
    :id="LIVE_REGION_IDS.polite"
    class="a11y-live-region"
    aria-live="polite"
    aria-atomic="true"
  />
  <div
    :id="LIVE_REGION_IDS.assertive"
    class="a11y-live-region"
    aria-live="assertive"
    aria-atomic="true"
  />
</template>

<style scoped>
.a11y-live-region {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
  /* Keep it in the accessibility tree: do NOT set aria-hidden or display:none. */
}
</style>
