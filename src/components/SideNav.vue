<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  HomeOutline,
  MusicalNotesOutline,
  CubeOutline,
  GitNetworkOutline,
  FolderOpenOutline,
  SettingsOutline,
} from '@vicons/ionicons5'

const route = useRoute()
const { t } = useI18n()
const items = computed(() => [
  { name: 'home', path: '/', icon: HomeOutline, label: t('nav.home') },
  { name: 'separate', path: '/separate', icon: MusicalNotesOutline, label: t('nav.separate') },
  { name: 'models', path: '/models', icon: CubeOutline, label: t('nav.models') },
  { name: 'workflows', path: '/workflows', icon: GitNetworkOutline, label: t('nav.workflows') },
  { name: 'results', path: '/results', icon: FolderOpenOutline, label: t('nav.results') },
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
