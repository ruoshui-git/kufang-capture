import { repo } from '../db'

const units = ['pieces', 'boxes', 'packs', '']

/** Create a clearly synthetic Local Only collection for manual performance checks. */
export async function generateSampleData(): Promise<{ collectionId: string; name: string }> {
  const collection = await repo.createCollection({
    name: `Test data ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
    description: 'Generated sample data for performance testing. Safe to clear after testing.',
    storage_mode: 'local_only',
  })

  for (let index = 0; index < 300; index += 1) {
    const entry = await repo.createEntry(collection.id, {
      title: '',
      quantity: index % 5 === 0 ? null : String((index % 23) + 1),
      unit: units[index % units.length]!,
      notes: index % 7 === 0 ? `Synthetic sample note ${index + 1}` : '',
    })
    const photoCount = index % 4
    if (photoCount > 0) {
      const photos = await Promise.all(
        Array.from({ length: photoCount }, (_, photoIndex) => createSamplePhoto(index, photoIndex)),
      )
      await repo.addPhotos(entry.id, photos)
    }
  }

  return { collectionId: collection.id, name: collection.name }
}

async function createSamplePhoto(entryIndex: number, photoIndex: number) {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 48
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas is unavailable for generating test data.')

  context.fillStyle = `hsl(${(entryIndex * 31 + photoIndex * 73) % 360} 55% 65%)`
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = '#172027'
  context.font = 'bold 12px sans-serif'
  context.fillText(`${entryIndex + 1}:${photoIndex + 1}`, 4, 26)
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('Could not generate a sample photo.'))),
      'image/jpeg',
      0.55,
    ),
  )

  return {
    blob,
    filename: `sample-${entryIndex + 1}-${photoIndex + 1}.jpg`,
    source: 'photo_library' as const,
  }
}
