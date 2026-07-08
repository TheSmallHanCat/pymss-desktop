import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'separate', component: () => import('@/views/SeparateView.vue') },
    { path: '/separate', redirect: { name: 'separate' } },
    { path: '/tasks', redirect: { name: 'results' } },
    { path: '/models', name: 'models', component: () => import('@/views/ModelsView.vue') },
    { path: '/workflows', name: 'workflows', component: () => import('@/views/WorkflowsView.vue') },
    { path: '/results', name: 'results', component: () => import('@/views/ResultsView.vue') },
    { path: '/debug', name: 'debug', component: () => import('@/views/DebugView.vue') },
    { path: '/projects', redirect: { name: 'results' } },
    { path: '/editor', name: 'editor', component: () => import('@/views/EditorView.vue') },
    { path: '/settings', name: 'settings', component: () => import('@/views/SettingsView.vue') },
  ],
})

export default router
