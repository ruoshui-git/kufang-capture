import type { EntryPatch, Repo } from '../repo'

/** Debounced, serialized field writes that can be flushed on blur or when the page hides. */
export function createEntryAutosave(repo: Repo, entryId: string, delay = 300) {
  const timers = new Map<keyof EntryPatch, ReturnType<typeof setTimeout>>()
  const pending = new Map<keyof EntryPatch, EntryPatch[keyof EntryPatch]>()
  const inFlight = new Map<keyof EntryPatch, Promise<void>>()
  let writes = Promise.resolve()

  function flushField(field: keyof EntryPatch): Promise<void> {
    const active = inFlight.get(field)
    if (active) return active
    const timer = timers.get(field)
    if (timer) clearTimeout(timer)
    timers.delete(field)
    if (!pending.has(field)) return Promise.resolve()
    const value = pending.get(field)
    pending.delete(field)
    const write = writes.then(() => repo.updateEntry(entryId, { [field]: value } as EntryPatch))
    writes = write.catch(() => {})
    inFlight.set(field, write)
    const clearFlight = () => {
      if (inFlight.get(field) === write) inFlight.delete(field)
    }
    void write.then(clearFlight, clearFlight)
    return write
  }

  async function flush() {
    while (pending.size || inFlight.size) {
      await Promise.all([...[...pending.keys()].map(flushField), ...inFlight.values()])
    }
  }

  return {
    schedule(field: keyof EntryPatch, value: EntryPatch[keyof EntryPatch]) {
      const previous = timers.get(field)
      if (previous) clearTimeout(previous)
      pending.set(field, value)
      timers.set(
        field,
        setTimeout(() => void flushField(field).catch(() => {}), delay),
      )
    },
    flush,
    dispose: flush,
  }
}

export function normalizeQuantityInput(value: string): string | null | undefined {
  const trimmed = value.trim()
  if (!trimmed) return null
  const normalized = trimmed.replace(',', '.')
  return /^\d+(?:\.\d+)?$/.test(normalized) ? normalized : undefined
}
