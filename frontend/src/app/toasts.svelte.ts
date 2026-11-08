export type ToastInput = {
  message: string
  actionLabel?: string
  action?: () => void
  duration?: number
  persistent?: boolean
}
export type ToastItem = ToastInput & { id: number }
let nextId = 1
export const toasts = $state<{ items: ToastItem[] }>({ items: [] })

export function showToast(input: ToastInput) {
  const item = { ...input, id: nextId++ }
  toasts.items = [...toasts.items, item]
  if (!input.persistent) setTimeout(() => dismissToast(item.id), input.duration ?? 8000)
  return item.id
}

export function dismissToast(id: number) {
  toasts.items = toasts.items.filter((item) => item.id !== id)
}
