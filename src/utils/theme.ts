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
  surface: '#111318',
  surface1: '#181b21',
  surface2: '#20242b',
  surface3: '#292e37',
  onSurface: '#eef1f6',
  onSurfaceMuted: '#a8b0bd',
  outline: 'rgba(255, 255, 255, 0.10)',
  success: '#4caf7d',
  warning: '#d6a33a',
  danger: '#dc6675',
  shadowSoft: '0 18px 60px rgba(0, 0, 0, 0.22)',
}

const LIGHT_SURFACE: SurfacePalette = {
  surface: '#f7f8fb',
  surface1: '#ffffff',
  surface2: '#eef1f6',
  surface3: '#e5e9f0',
  onSurface: '#171a1f',
  onSurfaceMuted: '#667085',
  outline: 'rgba(17, 24, 39, 0.10)',
  success: '#2e7d58',
  warning: '#9a6b00',
  danger: '#b4233a',
  shadowSoft: '0 18px 60px rgba(31, 41, 55, 0.10)',
}

const THEME_PALETTES: Record<ThemeAccent, { light: ThemePalette; dark: ThemePalette }> = {
  blue: {
    dark: {
      primary: '#7aa2ff',
      primaryStrong: '#9bb8ff',
      primarySoft: 'rgba(122, 162, 255, 0.20)',
      primarySofter: 'rgba(122, 162, 255, 0.10)',
      primaryBorder: 'rgba(122, 162, 255, 0.42)',
      primaryGlow: 'rgba(122, 162, 255, 0.24)',
      primaryHover: '#9bb8ff',
      primaryPressed: '#9bb8ff',
      preview: ['#7aa2ff', '#9bb8ff'],
    },
    light: {
      primary: '#315fbd',
      primaryStrong: '#234a95',
      primarySoft: 'rgba(49, 95, 189, 0.16)',
      primarySofter: 'rgba(49, 95, 189, 0.08)',
      primaryBorder: 'rgba(49, 95, 189, 0.30)',
      primaryGlow: 'rgba(49, 95, 189, 0.18)',
      primaryHover: '#234a95',
      primaryPressed: '#234a95',
      preview: ['#315fbd', '#6f93d6'],
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
      borderRadius: '10px',
      textColor: tokens.onSurface,
      color: tokens.surface2,
      borderColor: tokens.outline,
      colorHover: tokens.surface3,
      textColorHover: tokens.onSurface,
    },
    Input: {
      borderRadius: '10px',
      color: tokens.surface2,
      textColor: tokens.onSurface,
      border: `1px solid ${tokens.outline}`,
      borderHover: `1px solid ${tokens.primary}`,
      borderFocus: `1px solid ${tokens.primary}`,
    },
    Select: {
      borderRadius: '10px',
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
