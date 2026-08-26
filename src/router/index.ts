import { createRouter, createWebHashHistory } from 'vue-router'
import i18n from '@/i18n'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'separate', component: () => import('@/views/SeparateView.vue') },
    { path: '/separate', redirect: { name: 'separate' } },
    { path: '/tasks', redirect: { name: 'results' } },
    { path: '/models', name: 'models', component: () => import('@/views/ModelsView.vue') },
    { path: '/workflows', name: 'workflows', component: () => import('@/views/WorkflowsView.vue') },
    { path: '/workflow-node-editor', name: 'workflow-node-editor', component: () => import('@/views/WorkflowNodeEditorView.vue') },
    { path: '/results', name: 'results', component: () => import('@/views/ResultsView.vue') },
    { path: '/debug', name: 'debug', component: () => import('@/views/DebugView.vue') },
    { path: '/projects', redirect: { name: 'results' } },
    { path: '/editor', name: 'editor', component: () => import('@/views/EditorView.vue') },
    { path: '/simple', name: 'simple', component: () => import('@/views/SimpleView.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
  ],
})

const APP_NAME = 'Pymss Studio'

function routeTitle(routeName: unknown): string {
  if (typeof routeName !== 'string') return APP_NAME
  // The nav namespace carries a label for every route name; fall back to the
  // raw name if a translation is missing (vue-i18n returns the key itself).
  const label = i18n.global.t(`nav.${routeName}`)
  return label === `nav.${routeName}` ? APP_NAME : `${label} · ${APP_NAME}`
}

// After every navigation: move keyboard focus to the main content region so
// screen-reader users land on the new page instead of staying in the sidebar,
// and sync document.title so the reader announces the new page by name.
router.afterEach((to) => {
  if (typeof document === 'undefined') return
  document.title = routeTitle(to.name)

  // Defer the focus move until the new view has mounted. requestAnimationFrame
  // runs after Vue's navigation resolve + DOM patch for the hash router.
  requestAnimationFrame(() => {
    const main = document.getElementById('main-content')
    if (main) {
      // Focus the region itself (tabindex=-1 makes it programmatically focusable
      // without adding it to the Tab order). Only steal focus when focus is not
      // already inside the main region, so we don't disrupt in-page focus.
      const active = document.activeElement
      if (!active || !main.contains(active)) {
        main.focus({ preventScroll: true })
      }
    }
  })
})

export default router
