<script setup lang="ts">
import { GitNetworkOutline, ListOutline } from '@vicons/ionicons5'
import { useI18n } from 'vue-i18n'

type WorkflowCreateType = 'simple' | 'advanced'

defineProps<{ show: boolean }>()

const emit = defineEmits<{
  'update:show': [value: boolean]
  select: [type: WorkflowCreateType]
}>()

const { t } = useI18n()

function close() {
  emit('update:show', false)
}

function select(type: WorkflowCreateType) {
  emit('update:show', false)
  emit('select', type)
}
</script>

<template>
  <n-modal
    :show="show"
    :mask-closable="true"
    @update:show="emit('update:show', $event)"
  >
    <div
      class="workflow-create-chooser"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workflow-create-chooser-title"
    >
      <header class="workflow-create-chooser__header">
        <div>
          <h2 id="workflow-create-chooser-title">{{ t('workflows.createTypeTitle') }}</h2>
          <p>{{ t('workflows.createTypeDescription') }}</p>
        </div>
        <n-button quaternary size="small" @click="close">{{ t('common.cancel') }}</n-button>
      </header>

      <div class="workflow-create-chooser__options">
        <button
          type="button"
          class="workflow-create-option"
          @click="select('simple')"
        >
          <span class="workflow-create-option__icon">
            <n-icon :component="ListOutline" />
          </span>
          <span class="workflow-create-option__content">
            <span class="workflow-create-option__heading">
              <strong>{{ t('workflows.createSimpleTitle') }}</strong>
              <em>{{ t('workflows.createSimpleBadge') }}</em>
            </span>
            <span class="workflow-create-option__description">
              {{ t('workflows.createSimpleDescription') }}
            </span>
            <span class="workflow-create-option__action">
              {{ t('workflows.createSimpleAction') }}
            </span>
          </span>
        </button>

        <button
          type="button"
          class="workflow-create-option"
          @click="select('advanced')"
        >
          <span class="workflow-create-option__icon">
            <n-icon :component="GitNetworkOutline" />
          </span>
          <span class="workflow-create-option__content">
            <span class="workflow-create-option__heading">
              <strong>{{ t('workflows.createAdvancedTitle') }}</strong>
              <em>{{ t('workflows.createAdvancedBadge') }}</em>
            </span>
            <span class="workflow-create-option__description">
              {{ t('workflows.createAdvancedDescription') }}
            </span>
            <span class="workflow-create-option__action">
              {{ t('workflows.createAdvancedAction') }}
            </span>
          </span>
        </button>
      </div>

    </div>
  </n-modal>
</template>

<style scoped>
.workflow-create-chooser {
  width: min(720px, calc(100vw - 32px));
  max-height: calc(100vh - 48px);
  display: grid;
  gap: 20px;
  padding: 22px;
  overflow: auto;
  border: 1px solid var(--outline);
  border-radius: 18px;
  background: var(--surface-1);
  color: var(--on-surface);
}

.workflow-create-chooser__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.workflow-create-chooser__header h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
}

.workflow-create-chooser__header p {
  max-width: 560px;
  margin: 6px 0 0;
  color: var(--on-surface-muted);
  font-size: 13px;
  line-height: 1.6;
}

.workflow-create-chooser__options {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.workflow-create-option {
  min-width: 0;
  min-height: 210px;
  display: grid;
  grid-template-rows: auto 1fr;
  align-content: start;
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--outline);
  border-radius: 15px;
  background: var(--surface-2);
  color: var(--on-surface);
  cursor: pointer;
  text-align: left;
  font: inherit;
  transition: border-color 140ms ease, background 140ms ease;
}

.workflow-create-option:hover,
.workflow-create-option:focus-visible {
  border-color: color-mix(in srgb, var(--primary) 46%, var(--outline));
  background: color-mix(in srgb, var(--primary-soft) 16%, var(--surface-2));
  outline: none;
}

.workflow-create-option__icon {
  width: 40px;
  height: 40px;
  display: grid;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--primary) 22%, var(--outline));
  border-radius: 12px;
  color: var(--primary-strong);
  background: color-mix(in srgb, var(--primary-soft) 34%, var(--surface-1));
  font-size: 21px;
}

.workflow-create-option__content {
  min-width: 0;
  display: grid;
  grid-template-rows: auto 1fr auto;
  gap: 9px;
}

.workflow-create-option__heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.workflow-create-option__heading strong {
  font-size: 16px;
  font-weight: 700;
}

.workflow-create-option__heading em {
  flex: 0 0 auto;
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--primary-strong);
  background: color-mix(in srgb, var(--primary-soft) 40%, transparent);
  font-size: 11px;
  font-style: normal;
  font-weight: 650;
}

.workflow-create-option__description {
  color: var(--on-surface-muted);
  font-size: 13px;
  line-height: 1.65;
}

.workflow-create-option__action {
  color: var(--primary-strong);
  font-size: 13px;
  font-weight: 650;
}

@media (max-width: 680px) {
  .workflow-create-chooser {
    padding: 18px;
  }

  .workflow-create-chooser__options {
    grid-template-columns: minmax(0, 1fr);
  }

  .workflow-create-option {
    min-height: 176px;
  }
}
</style>
