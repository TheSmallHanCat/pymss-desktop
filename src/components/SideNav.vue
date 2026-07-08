<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useSettingsStore } from '@/stores/settings'
import {
  MusicalNotesOutline,
  CubeOutline,
  GitNetworkOutline,
  FolderOpenOutline,
  SettingsOutline,
  TerminalOutline,
} from '@vicons/ionicons5'

const route = useRoute()
const { t } = useI18n()
const settings = useSettingsStore()
const items = computed(() => [
  { name: 'separate', path: '/', icon: MusicalNotesOutline, label: t('nav.separate') },
  { name: 'models', path: '/models', icon: CubeOutline, label: t('nav.models') },
  { name: 'workflows', path: '/workflows', icon: GitNetworkOutline, label: t('nav.workflows') },
  { name: 'results', path: '/results', icon: FolderOpenOutline, label: t('nav.results') },
  ...(settings.developerMode ? [{ name: 'debug', path: '/debug', icon: TerminalOutline, label: t('nav.debug') }] : []),
  { name: 'settings', path: '/settings', icon: SettingsOutline, label: t('nav.settings') },
])
</script>

<template>
  <aside class="side-nav">
    <router-link
      v-for="item in items"
      :key="item.name"
      class="nav-item"
      :class="{ active: route.name === item.name }"
      :to="item.path"
      :title="item.label"
    >
      <span class="nav-icon">
        <n-icon :component="item.icon" :size="18" />
      </span>
      <span>{{ item.label }}</span>
    </router-link>
  </aside>
</template>
