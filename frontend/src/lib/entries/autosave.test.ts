import { describe, expect, it, vi } from 'vitest'
import { createEntryAutosave, normalizeQuantityInput } from './autosave'
import type { Repo } from '../repo'

describe('entry autosave', () => {
  it('debounces fields independently and flushes pending values', async () => {
    const updateEntry = vi.fn().mockResolvedValue(undefined)
    const autosave = createEntryAutosave({ updateEntry } as unknown as Repo, 'entry', 1000)
    autosave.schedule('title', 'Shelf A')
    autosave.schedule('unit', 'boxes')
    await autosave.flush()
    expect(updateEntry).toHaveBeenCalledTimes(2)
    expect(updateEntry).toHaveBeenCalledWith('entry', { title: 'Shelf A' })
    expect(updateEntry).toHaveBeenCalledWith('entry', { unit: 'boxes' })
  })

  it('normalizes decimal commas and rejects non-decimal text', () => {
    expect(normalizeQuantityInput(' 1,5 ')).toBe('1.5')
    expect(normalizeQuantityInput('12')).toBe('12')
    expect(normalizeQuantityInput('')).toBeNull()
    expect(normalizeQuantityInput('2 boxes')).toBeUndefined()
  })
})
