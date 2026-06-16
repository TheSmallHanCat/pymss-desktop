import { createI18n } from 'vue-i18n'
import zhCN from './zh-CN.json'
import en from './en.json'
import { runRippleViewTransition } from '@/utils/theme'

export const SYSTEM_LOCALE = 'system' as const
export const SUPPORTED_LOCALES = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en', label: 'English' },
] as const

export type SupportedLocale = typeof SUPPORTED_LOCALES[number]['code']
export type LocaleSetting = typeof SYSTEM_LOCALE | SupportedLocale

function isSupportedLocale(value: unknown): value is SupportedLocale {
  return value === 'zh-CN' || value === 'en'
}

export function normalizeLocaleSetting(
  value: unknown,
  fallback: LocaleSetting = SYSTEM_LOCALE,
): LocaleSetting {
  return value === SYSTEM_LOCALE || isSupportedLocale(value) ? value : fallback
}

export function detectSystemLocale(): SupportedLocale {
  const nav = navigator.language || 'zh-CN'
  return nav.startsWith('zh') ? 'zh-CN' : 'en'
}

export function detectLocale(): SupportedLocale {
  return detectSystemLocale()
}

export function resolveLocaleSetting(locale: LocaleSetting): SupportedLocale {
  return locale === SYSTEM_LOCALE ? detectSystemLocale() : locale
}

let currentLocaleSetting: LocaleSetting = SYSTEM_LOCALE

function applyResolvedLocale(locale: SupportedLocale) {
  ;(i18n.global.locale as any).value = locale
  document.documentElement.lang = locale
}

const i18n = createI18n({
  legacy: false,
  locale: detectSystemLocale(),
  fallbackLocale: 'zh-CN',
  messages: {
    'zh-CN': zhCN,
    en,
  },
})

if (typeof window !== 'undefined') {
  window.addEventListener('languagechange', () => {
    if (currentLocaleSetting === SYSTEM_LOCALE) {
      applyResolvedLocale(detectSystemLocale())
    }
  })
}

export function setLocale(locale: LocaleSetting) {
  currentLocaleSetting = normalizeLocaleSetting(locale)
  applyResolvedLocale(resolveLocaleSetting(currentLocaleSetting))
}

export async function setLocaleWithTransition(
  locale: LocaleSetting,
  origin?: { x: number; y: number },
) {
  await runRippleViewTransition(() => {
    setLocale(locale)
  }, origin)
}

export function getCurrentLocale(): SupportedLocale {
  const current = (i18n.global.locale as any)?.value ?? i18n.global.locale
  return current === 'en' ? 'en' : 'zh-CN'
}

export default i18n
