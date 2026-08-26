<script setup lang="ts">
/**
 * SrText — visually hidden text that remains available to screen readers.
 *
 * Renders a `<span class="sr-only">` by default. Use it to label icon-only
 * buttons, add context to ambiguous controls, or provide off-screen
 * announcements paired with `useLiveAnnouncer`.
 *
 * Pass `as="div"` (or any tag) when a block element is needed, e.g. inside
 * a flex/grid context where an inline span would disturb layout.
 */
withDefaults(defineProps<{
  as?: string
}>(), {
  as: 'span',
})
</script>

<template>
  <component :is="as" class="sr-only"><slot /></component>
</template>

<style scoped>
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
