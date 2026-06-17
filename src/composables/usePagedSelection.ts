import { computed, ref, unref, watch, type ComputedRef, type Ref } from 'vue'

type Identifiable = { id: string }

type UsePagedSelectionOptions = {
  initialPageSize: number
  pageSizeOptions: number[]
}

type ItemsSource<T> = ComputedRef<T[]> | Ref<T[]>

export function usePagedSelection<T extends Identifiable>(
  items: ItemsSource<T>,
  options: UsePagedSelectionOptions,
) {
  const selecting = ref(false)
  const selectedIds = ref<string[]>([])
  const page = ref(1)
  const pageSize = ref(options.initialPageSize)

  const pagedItems = computed(() => {
    const list = unref(items)
    const start = (page.value - 1) * pageSize.value
    return list.slice(start, start + pageSize.value)
  })

  const selectedSet = computed(() => new Set(selectedIds.value))
  const allSelected = computed(() =>
    pagedItems.value.length > 0 && pagedItems.value.every((item) => selectedSet.value.has(item.id)),
  )
  const someSelected = computed(() =>
    pagedItems.value.some((item) => selectedSet.value.has(item.id)) && !allSelected.value,
  )

  watch(pageSize, () => {
    page.value = 1
  })

  watch(() => unref(items), (list) => {
    const visibleIds = new Set(list.map((item) => item.id))
    selectedIds.value = selectedIds.value.filter((id) => visibleIds.has(id))
    if (selecting.value && !list.length) {
      selecting.value = false
    }
    const maxPage = Math.max(1, Math.ceil(list.length / pageSize.value))
    if (page.value > maxPage) page.value = maxPage
  }, { immediate: true })

  function toggleSelecting() {
    selecting.value = !selecting.value
    if (!selecting.value) selectedIds.value = []
  }

  function toggleSelection(id: string) {
    selectedIds.value = selectedSet.value.has(id)
      ? selectedIds.value.filter((item) => item !== id)
      : [...selectedIds.value, id]
  }

  function toggleSelectPage(checked: boolean) {
    const pageIds = pagedItems.value.map((item) => item.id)
    if (!checked) {
      selectedIds.value = selectedIds.value.filter((id) => !pageIds.includes(id))
      return
    }
    selectedIds.value = Array.from(new Set([...selectedIds.value, ...pageIds]))
  }

  function ensureItemPage(id: string) {
    const index = unref(items).findIndex((item) => item.id === id)
    if (index >= 0) {
      page.value = Math.floor(index / pageSize.value) + 1
    }
  }

  return {
    selecting,
    selectedIds,
    selectedSet,
    page,
    pageSize,
    pageSizeOptions: options.pageSizeOptions,
    pagedItems,
    allSelected,
    someSelected,
    toggleSelecting,
    toggleSelection,
    toggleSelectPage,
    ensureItemPage,
  }
}
