import type { EntryPatch, Repo } from '../repo'

/** Debounced field writes that can be flushed on blur or when the page hides. */
export function createEntryAutosave(repo: Repo, entryId: string, delay = 300) {
  const timers = new Map<keyof EntryPatch, ReturnType<typeof setTimeout>>()
  const pending = new Map<keyof EntryPatch, EntryPatch[keyof EntryPatch]>()

  async function flushField(field: keyof EntryPatch) {
    const timer = timers.get(field)
    if (timer) clearTimeout(timer)
    timers.delete(field)
    if (!pending.has(field)) return
    const value = pending.get(field)
    pending.delete(field)
    await repo.updateEntry(entryId, { [field]: value } as EntryPatch)
  }

  return {
    schedule(field: keyof EntryPatch, value: EntryPatch[keyof EntryPatch]) {
      const previous = timers.get(field)
      if (previous) clearTimeout(previous)
      pending.set(field, value)
      timers.set(
        field,
        setTimeout(() => void flushField(field), delay),
      )
    },
    async flush() {
      await Promise.all([...pending.keys()].map(flushField))
    },
    async dispose() {
      await this.flush()
    },
  }
}

export function normalizeQuantityInput(value: string): string | null | undefined {
  const trimmed = value.trim()
  if (!trimmed) return null
  const normalized = trimmed.replace(',', '.')
  return /^\d+(?:\.\d+)?$/.test(normalized) ? normalized : undefined
}
