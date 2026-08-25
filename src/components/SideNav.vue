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
  AccessibilityOutline,
} from '@vicons/ionicons5'

const route = useRoute()
const { t } = useI18n()
const settings = useSettingsStore()
const mainItems = computed(() => [
  { name: 'separate', path: '/', icon: MusicalNotesOutline, label: t('nav.separate') },
  { name: 'models', path: '/models', icon: CubeOutline, label: t('nav.models') },
  { name: 'workflows', path: '/workflows', icon: GitNetworkOutline, label: t('nav.workflows') },
  { name: 'results', path: '/results', icon: FolderOpenOutline, label: t('nav.results') },
])
const bottomItems = computed(() => [
  { name: 'simple', path: '/simple', icon: AccessibilityOutline, label: t('nav.simple') },
  ...(settings.developerMode ? [{ name: 'debug', path: '/debug', icon: TerminalOutline, label: t('nav.debug') }] : []),
  { name: 'settings', path: '/settings', icon: SettingsOutline, label: t('nav.settings') },
])
</script>

<template>
  <nav class="side-nav" :aria-label="t('a11y.primaryNav')">
    <div class="side-nav__main">
      <router-link
        v-for="item in mainItems"
        :key="item.name"
        class="nav-item"
        :class="{ active: route.name === item.name }"
        :to="item.path"
        :title="item.label"
        :aria-current="route.name === item.name ? 'page' : undefined"
      >
        <span class="nav-icon">
          <n-icon :component="item.icon" :size="18" />
        </span>
        <span>{{ item.label }}</span>
      </router-link>
    </div>
    <div class="side-nav__bottom">
      <router-link
        v-for="item in bottomItems"
        :key="item.name"
        class="nav-item"
        :class="[
          { active: route.name === item.name },
          'nav-item--utility',
          item.name === 'debug' ? 'nav-item--debug' : '',
        ]"
        :to="item.path"
        :title="item.label"
        :aria-current="route.name === item.name ? 'page' : undefined"
      >
        <span class="nav-icon">
          <n-icon :component="item.icon" :size="18" />
        </span>
        <span>{{ item.label }}</span>
      </router-link>
    </div>
  </nav>
</template>
