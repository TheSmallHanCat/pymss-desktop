import type { GlobalThemeOverrides } from 'naive-ui'

export type ThemeMode = 'system' | 'dark' | 'light'
export type ThemeAccent = 'blue' | 'pink' | 'sky' | 'teal'

type ThemePalette = {
  primary: string
  primaryStrong: string
  primarySoft: string
  primarySofter: string
  primaryBorder: string
  primaryGlow: string
  primaryHover: string
  primaryPressed: string
  preview: [string, string]
}

type SurfacePalette = {
  surface: string
  surface1: string
  surface2: string
  surface3: string
  onSurface: string
  onSurfaceMuted: string
  outline: string
  success: string
  warning: string
  danger: string
  shadowSoft: string
}

export type ResolvedThemeTokens = SurfacePalette & ThemePalette & {
  isDark: boolean
}

type ViewTransitionLike = {
  ready: Promise<void>
}

type DocumentWithViewTransition = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => ViewTransitionLike
}

const RIPPLE_TRANSITION_DURATION = 700
const RIPPLE_TRANSITION_EASING = 'cubic-bezier(0.2, 0, 0, 1)'

const DARK_SURFACE: SurfacePalette = {
  surface: '#0e1117',
  surface1: '#171b23',
  surface2: '#202633',
  surface3: '#2a3140',
  onSurface: '#f4f7fb',
  onSurfaceMuted: '#9da8b8',
  outline: 'rgba(155, 170, 194, 0.14)',
  success: '#62bf91',
  warning: '#d9a84d',
  danger: '#e16d7d',
  shadowSoft: '0 24px 80px rgba(0, 0, 0, 0.34)',
}

const LIGHT_SURFACE: SurfacePalette = {
  surface: '#f4f6fa',
  surface1: '#fbfcff',
  surface2: '#eef2f7',
  surface3: '#dfe5ee',
  onSurface: '#172033',
  onSurfaceMuted: '#596579',
  outline: 'rgba(31, 42, 68, 0.13)',
  success: '#2e7d58',
  warning: '#9a6b00',
  danger: '#b4233a',
  shadowSoft: '0 20px 70px rgba(33, 43, 67, 0.11)',
}

const THEME_PALETTES: Record<ThemeAccent, { light: ThemePalette; dark: ThemePalette }> = {
  blue: {
    dark: {
      primary: '#6f9df7',
      primaryStrong: '#a9c2ff',
      primarySoft: 'rgba(111, 157, 247, 0.16)',
      primarySofter: 'rgba(111, 157, 247, 0.08)',
      primaryBorder: 'rgba(111, 157, 247, 0.30)',
      primaryGlow: 'rgba(111, 157, 247, 0.18)',
      primaryHover: '#90b5ff',
      primaryPressed: '#b1c8ff',
      preview: ['#6f9df7', '#a9c2ff'],
    },
    light: {
      primary: '#3f70d4',
      primaryStrong: '#2454ad',
      primarySoft: 'rgba(63, 112, 212, 0.13)',
      primarySofter: 'rgba(63, 112, 212, 0.07)',
      primaryBorder: 'rgba(63, 112, 212, 0.24)',
      primaryGlow: 'rgba(63, 112, 212, 0.14)',
      primaryHover: '#2f61c2',
      primaryPressed: '#244f9f',
      preview: ['#3f70d4', '#83a7ea'],
    },
  },
  pink: {
    dark: {
      primary: '#f3a5c8',
      primaryStrong: '#ffd0e4',
      primarySoft: 'rgba(243, 165, 200, 0.22)',
      primarySofter: 'rgba(243, 165, 200, 0.10)',
      primaryBorder: 'rgba(243, 165, 200, 0.46)',
      primaryGlow: 'rgba(243, 165, 200, 0.26)',
      primaryHover: '#ffd0e4',
      primaryPressed: '#ffd0e4',
      preview: ['#f3a5c8', '#ffd0e4'],
    },
    light: {
      primary: '#d56f9f',
      primaryStrong: '#b44e7f',
      primarySoft: 'rgba(213, 111, 159, 0.18)',
      primarySofter: 'rgba(213, 111, 159, 0.08)',
      primaryBorder: 'rgba(213, 111, 159, 0.34)',
      primaryGlow: 'rgba(213, 111, 159, 0.20)',
      primaryHover: '#b44e7f',
      primaryPressed: '#b44e7f',
      preview: ['#d56f9f', '#f2b9d3'],
    },
  },
  sky: {
    dark: {
      primary: '#89c8ff',
      primaryStrong: '#b7ddff',
      primarySoft: 'rgba(137, 200, 255, 0.22)',
      primarySofter: 'rgba(137, 200, 255, 0.10)',
      primaryBorder: 'rgba(137, 200, 255, 0.42)',
      primaryGlow: 'rgba(137, 200, 255, 0.24)',
      primaryHover: '#b7ddff',
      primaryPressed: '#b7ddff',
      preview: ['#89c8ff', '#b7ddff'],
    },
    light: {
      primary: '#4d8fd8',
      primaryStrong: '#2f74c0',
      primarySoft: 'rgba(77, 143, 216, 0.18)',
      primarySofter: 'rgba(77, 143, 216, 0.08)',
      primaryBorder: 'rgba(77, 143, 216, 0.34)',
      primaryGlow: 'rgba(77, 143, 216, 0.20)',
      primaryHover: '#2f74c0',
      primaryPressed: '#2f74c0',
      preview: ['#4d8fd8', '#9bcbf5'],
    },
  },
  teal: {
    dark: {
      primary: '#67d2c1',
      primaryStrong: '#9ce9dc',
      primarySoft: 'rgba(103, 210, 193, 0.22)',
      primarySofter: 'rgba(103, 210, 193, 0.10)',
      primaryBorder: 'rgba(103, 210, 193, 0.42)',
      primaryGlow: 'rgba(103, 210, 193, 0.24)',
      primaryHover: '#9ce9dc',
      primaryPressed: '#9ce9dc',
      preview: ['#67d2c1', '#9ce9dc'],
    },
    light: {
      primary: '#238c7b',
      primaryStrong: '#156f61',
      primarySoft: 'rgba(35, 140, 123, 0.18)',
      primarySofter: 'rgba(35, 140, 123, 0.08)',
      primaryBorder: 'rgba(35, 140, 123, 0.34)',
      primaryGlow: 'rgba(35, 140, 123, 0.20)',
      primaryHover: '#156f61',
      primaryPressed: '#156f61',
      preview: ['#238c7b', '#84d6ca'],
    },
  },
}

export const DEFAULT_THEME_MODE: ThemeMode = 'system'
export const DEFAULT_THEME_ACCENT: ThemeAccent = 'blue'
export const THEME_ACCENTS: ThemeAccent[] = ['blue', 'pink', 'sky', 'teal']

let currentMode: ThemeMode = DEFAULT_THEME_MODE
let currentAccent: ThemeAccent = DEFAULT_THEME_ACCENT

function isThemeMode(value: string | null | undefined): value is ThemeMode {
  return value === 'system' || value === 'dark' || value === 'light'
}

function isThemeAccent(value: string | null | undefined): value is ThemeAccent {
  return value === 'blue' || value === 'pink' || value === 'sky' || value === 'teal'
}

export function normalizeThemeMode(value: string | null | undefined, fallback: ThemeMode = DEFAULT_THEME_MODE): ThemeMode {
  return isThemeMode(value) ? value : fallback
}

export function normalizeThemeAccent(
  value: string | null | undefined,
  fallback: ThemeAccent = DEFAULT_THEME_ACCENT,
): ThemeAccent {
  return isThemeAccent(value) ? value : fallback
}

export function resolvedIsDark(mode: ThemeMode = currentMode): boolean {
  return mode === 'dark' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

export function getResolvedThemeTokens(
  mode: ThemeMode = currentMode,
  accent: ThemeAccent = currentAccent,
): ResolvedThemeTokens {
  const dark = resolvedIsDark(mode)
  const surface = dark ? DARK_SURFACE : LIGHT_SURFACE
  const palette = THEME_PALETTES[accent][dark ? 'dark' : 'light']
  return {
    ...surface,
    ...palette,
    isDark: dark,
  }
}

export function getThemeAccentPreview(accent: ThemeAccent, dark: boolean) {
  return THEME_PALETTES[accent][dark ? 'dark' : 'light'].preview
}

function applyThemeClass(mode: ThemeMode) {
  const dark = resolvedIsDark(mode)
  document.documentElement.classList.toggle('dark-theme', dark)
  document.documentElement.classList.toggle('light-theme', !dark)
}

function applyThemeTokens(mode: ThemeMode, accent: ThemeAccent) {
  const tokens = getResolvedThemeTokens(mode, accent)
  const style = document.documentElement.style
  style.setProperty('--surface', tokens.surface)
  style.setProperty('--surface-1', tokens.surface1)
  style.setProperty('--surface-2', tokens.surface2)
  style.setProperty('--surface-3', tokens.surface3)
  style.setProperty('--on-surface', tokens.onSurface)
  style.setProperty('--on-surface-muted', tokens.onSurfaceMuted)
  style.setProperty('--outline', tokens.outline)
  style.setProperty('--primary', tokens.primary)
  style.setProperty('--primary-strong', tokens.primaryStrong)
  style.setProperty('--primary-soft', tokens.primarySoft)
  style.setProperty('--primary-softer', tokens.primarySofter)
  style.setProperty('--primary-border', tokens.primaryBorder)
  style.setProperty('--primary-glow', tokens.primaryGlow)
  style.setProperty('--success', tokens.success)
  style.setProperty('--warning', tokens.warning)
  style.setProperty('--danger', tokens.danger)
  style.setProperty('--shadow-soft', tokens.shadowSoft)
}

export function getThemeOverrides(
  mode: ThemeMode = currentMode,
  accent: ThemeAccent = currentAccent,
): GlobalThemeOverrides {
  const tokens = getResolvedThemeTokens(mode, accent)
  return {
    common: {
      bodyColor: tokens.surface,
      cardColor: tokens.surface1,
      modalColor: tokens.surface1,
      popoverColor: tokens.surface1,
      tableColor: tokens.surface1,
      inputColor: tokens.surface2,
      actionColor: tokens.surface2,
      hoverColor: tokens.surface2,
      dividerColor: tokens.outline,
      borderColor: tokens.outline,
      textColor1: tokens.onSurface,
      textColor2: tokens.onSurfaceMuted,
      textColor3: tokens.onSurfaceMuted,
      primaryColor: tokens.primary,
      primaryColorHover: tokens.primaryHover,
      primaryColorPressed: tokens.primaryPressed,
      primaryColorSuppl: tokens.primary,
      successColor: tokens.success,
      warningColor: tokens.warning,
      errorColor: tokens.danger,
      placeholderColor: tokens.onSurfaceMuted,
      tableHeaderColor: tokens.surface2,
    },
    Card: {
      paddingMedium: '20px',
      borderRadius: '16px',
      titleTextColor: tokens.onSurface,
      color: tokens.surface1,
      borderColor: tokens.outline,
    },
    Button: {
      borderRadius: '11px',
      textColor: tokens.onSurface,
      color: tokens.surface2,
      borderColor: tokens.outline,
      colorHover: tokens.surface3,
      textColorHover: tokens.onSurface,
    },
    Input: {
      borderRadius: '11px',
      color: tokens.surface2,
      textColor: tokens.onSurface,
      border: `1px solid ${tokens.outline}`,
      borderHover: `1px solid ${tokens.primary}`,
      borderFocus: `1px solid ${tokens.primary}`,
    },
    Select: {
      borderRadius: '11px',
      menuColor: tokens.surface1,
    },
    Tag: {
      borderRadius: '8px',
    },
    Progress: {
      railColor: tokens.surface3,
    },
    Menu: {
      itemColorActive: tokens.primarySoft,
      itemTextColorActive: tokens.primaryStrong,
      itemTextColor: tokens.onSurfaceMuted,
      itemColorHover: tokens.surface2,
      itemTextColorHover: tokens.onSurface,
      borderRadius: '10px',
    },
    Steps: {
      stepHeaderFontSizeSmall: '14px',
      stepIndicatorTextColorFinished: tokens.primary,
      stepHeaderTextColorFinished: tokens.onSurface,
      stepIndicatorBorderColorFinished: tokens.primary,
      connectorColor: tokens.outline,
    },
    Collapse: {
      titleTextColor: tokens.onSurface,
      titleTextColorDisabled: tokens.onSurfaceMuted,
      dividerColor: tokens.outline,
      borderRadius: '12px',
    },
    DataTable: {
      tdColor: tokens.surface1,
      thColor: tokens.surface2,
      borderColor: tokens.outline,
    },
    Slider: {
      railColor: tokens.surface3,
    },
    Switch: {
      railColor: tokens.surface3,
      railColorActive: tokens.primary,
    },
    InputNumber: {
      color: tokens.surface2,
      border: `1px solid ${tokens.outline}`,
      borderHover: `1px solid ${tokens.primary}`,
      borderFocus: `1px solid ${tokens.primary}`,
    },
  }
}

export function applyTheme(mode: ThemeMode, accent: ThemeAccent = currentAccent) {
  currentMode = normalizeThemeMode(mode)
  currentAccent = normalizeThemeAccent(accent)
  applyThemeClass(currentMode)
  applyThemeTokens(currentMode, currentAccent)
}

export function initTheme(
  mode: ThemeMode = DEFAULT_THEME_MODE,
  accent: ThemeAccent = DEFAULT_THEME_ACCENT,
) {
  applyTheme(mode, accent)
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (currentMode === 'system') applyTheme(currentMode, currentAccent)
  })
}

export async function runRippleViewTransition(
  update: () => void | Promise<void>,
  origin?: { x: number; y: number },
) {
  const doc = document as DocumentWithViewTransition
  if (!origin || !doc.startViewTransition) {
    await update()
    return
  }

  const { x, y } = origin
  const maxRadius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  )

  const transition = doc.startViewTransition(async () => {
    await update()
  })

  try {
    await transition.ready
    document.documentElement.animate(
      {
        clipPath: [
          `circle(0px at ${x}px ${y}px)`,
          `circle(${maxRadius}px at ${x}px ${y}px)`,
        ],
        opacity: [0.7, 1],
      },
      {
        duration: RIPPLE_TRANSITION_DURATION,
        easing: RIPPLE_TRANSITION_EASING,
        pseudoElement: '::view-transition-new(root)',
      },
    )
  } catch {
    // ignore interrupted transitions
  }
}
