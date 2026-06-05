<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { darkTheme } from 'naive-ui'
import type { GlobalThemeOverrides } from 'naive-ui'
import TitleBar from '@/components/TitleBar.vue'
import SideNav from '@/components/SideNav.vue'
import AppBrandMark from '@/components/AppBrandMark.vue'
import { useSettingsStore } from '@/stores/settings'
import { useAppStore } from '@/stores/app'
import { resolvedIsDark } from '@/utils/theme'
import { useI18n } from 'vue-i18n'

const settings = useSettingsStore()
const app = useAppStore()
const { t } = useI18n()
const bootReady = ref(false)

const isDark = computed(() => resolvedIsDark(settings.themeMode))
const isEditorRoute = computed(() => location.hash.startsWith('#/editor'))

// Naive UI's seemly/rgba() requires actual CSS color values (not var() references)

onMounted(() => {
  requestAnimationFrame(() => {
    window.setTimeout(() => {
      bootReady.value = true
    }, 120)
  })
  if (!app.envInfo && !app.envLoading) {
    setTimeout(() => {
      app.checkEnvInBackground().catch(() => {})
    }, 120)
  }
})

const themeOverrides = computed<GlobalThemeOverrides>(() => {
  const dark = isDark.value
  return {
    common: {
      bodyColor: dark ? '#111318' : '#f7f8fb',
      cardColor: dark ? '#181b21' : '#ffffff',
      modalColor: dark ? '#181b21' : '#ffffff',
      popoverColor: dark ? '#181b21' : '#ffffff',
      tableColor: dark ? '#181b21' : '#ffffff',
      inputColor: dark ? '#20242b' : '#eef1f6',
      actionColor: dark ? '#20242b' : '#eef1f6',
      hoverColor: dark ? '#20242b' : '#eef1f6',
      dividerColor: dark ? 'rgba(255,255,255,0.10)' : 'rgba(17,24,39,0.10)',
      borderColor: dark ? 'rgba(255,255,255,0.10)' : 'rgba(17,24,39,0.10)',
      textColor1: dark ? '#eef1f6' : '#171a1f',
      textColor2: dark ? '#a8b0bd' : '#667085',
      textColor3: dark ? '#a8b0bd' : '#667085',
      primaryColor: dark ? '#7aa2ff' : '#315fbd',
      primaryColorHover: dark ? '#9bb8ff' : '#234a95',
      primaryColorPressed: dark ? '#9bb8ff' : '#234a95',
      primaryColorSuppl: dark ? '#7aa2ff' : '#315fbd',
      successColor: dark ? '#4caf7d' : '#2e7d58',
      warningColor: dark ? '#d6a33a' : '#9a6b00',
      errorColor: dark ? '#dc6675' : '#b4233a',
      placeholderColor: dark ? '#a8b0bd' : '#667085',
      tableHeaderColor: dark ? '#20242b' : '#eef1f6',
    },
    Card: {
      paddingMedium: '20px',
      borderRadius: '16px',
      titleTextColor: dark ? '#eef1f6' : '#171a1f',
      color: dark ? '#181b21' : '#ffffff',
      borderColor: dark ? 'rgba(255,255,255,0.10)' : 'rgba(17,24,39,0.10)',
    },
    Button: {
      borderRadius: '10px',
      textColor: dark ? '#eef1f6' : '#171a1f',
      color: dark ? '#20242b' : '#eef1f6',
      borderColor: dark ? 'rgba(255,255,255,0.10)' : 'rgba(17,24,39,0.10)',
      colorHover: dark ? '#292e37' : '#e5e9f0',
      textColorHover: dark ? '#eef1f6' : '#171a1f',
    },
    Input: {
      borderRadius: '10px',
      color: dark ? '#20242b' : '#eef1f6',
      textColor: dark ? '#eef1f6' : '#171a1f',
      border: dark ? '1px solid rgba(255,255,255,0.10)' : '1px solid rgba(17,24,39,0.10)',
      borderHover: dark ? '1px solid #7aa2ff' : '1px solid #315fbd',
      borderFocus: dark ? '1px solid #7aa2ff' : '1px solid #315fbd',
    },
    Select: {
      borderRadius: '10px',
      menuColor: dark ? '#181b21' : '#ffffff',
    },
    Tag: {
      borderRadius: '8px',
    },
    Progress: {
      railColor: dark ? '#292e37' : '#e5e9f0',
    },
    Menu: {
      itemColorActive: dark ? 'rgba(122,162,255,0.14)' : 'rgba(49,95,189,0.10)',
      itemTextColorActive: dark ? '#9bb8ff' : '#234a95',
      itemTextColor: dark ? '#a8b0bd' : '#667085',
      itemColorHover: dark ? '#20242b' : '#eef1f6',
      itemTextColorHover: dark ? '#eef1f6' : '#171a1f',
      borderRadius: '10px',
    },
    Steps: {
      stepHeaderFontSizeSmall: '14px',
      stepIndicatorTextColorFinished: dark ? '#7aa2ff' : '#315fbd',
      stepHeaderTextColorFinished: dark ? '#eef1f6' : '#171a1f',
      stepIndicatorBorderColorFinished: dark ? '#7aa2ff' : '#315fbd',
      connectorColor: dark ? 'rgba(255,255,255,0.10)' : 'rgba(17,24,39,0.10)',
    },
    Collapse: {
      titleTextColor: dark ? '#eef1f6' : '#171a1f',
      titleTextColorDisabled: dark ? '#a8b0bd' : '#667085',
      dividerColor: dark ? 'rgba(255,255,255,0.10)' : 'rgba(17,24,39,0.10)',
      borderRadius: '12px',
    },
    DataTable: {
      tdColor: dark ? '#181b21' : '#ffffff',
      thColor: dark ? '#20242b' : '#eef1f6',
      borderColor: dark ? 'rgba(255,255,255,0.10)' : 'rgba(17,24,39,0.10)',
    },
    Slider: {
      railColor: dark ? '#292e37' : '#e5e9f0',
    },
    Switch: {
      railColor: dark ? '#292e37' : '#e5e9f0',
      railColorActive: dark ? '#7aa2ff' : '#315fbd',
    },
  }
})
</script>

<template>
  <n-config-provider :theme="isDark ? darkTheme : null" :theme-overrides="themeOverrides">
    <n-notification-provider>
      <n-message-provider>
        <n-dialog-provider>
        <div class="app-shell" :class="{ 'app-shell--editor': isEditorRoute }">
          <div class="app-backdrop" />
          <TitleBar />
          <div class="app-body">
            <SideNav v-if="!isEditorRoute" />
            <main class="app-content">
              <router-view v-slot="{ Component, route }">
                <transition name="page" mode="out-in">
                  <component :is="Component" :key="route.path" />
                </transition>
              </router-view>
            </main>
          </div>
          <transition name="boot-fade">
            <div v-if="!bootReady" class="boot-splash">
              <AppBrandMark class="boot-splash__mark" :size="58" shadow />
            <div class="boot-splash__copy">
              <strong>Pymss Studio</strong>
                <span>{{ t('app.bootPreparing') }}</span>
              </div>
            </div>
          </transition>
        </div>
        </n-dialog-provider>
      </n-message-provider>
    </n-notification-provider>
  </n-config-provider>
</template>

<style scoped>
.boot-splash {
  position: absolute;
  inset: 0;
  z-index: 120;
  display: grid;
  place-items: center;
  gap: 14px;
  background:
    radial-gradient(circle at 20% 16%, rgba(122, 162, 255, 0.12), transparent 28%),
    linear-gradient(180deg, rgba(255,255,255,0.03), transparent 32%),
    var(--surface);
}

.boot-splash__mark {
  flex: 0 0 auto;
}

.boot-splash__copy {
  display: grid;
  gap: 6px;
  text-align: center;
}

.boot-splash__copy strong {
  font-size: 18px;
  letter-spacing: 0.01em;
}

.boot-splash__copy span {
  font-size: 12px;
  color: var(--on-surface-muted);
}

.boot-fade-enter-active,
.boot-fade-leave-active {
  transition: opacity 240ms ease;
}

.boot-fade-enter-from,
.boot-fade-leave-to {
  opacity: 0;
}
</style>
