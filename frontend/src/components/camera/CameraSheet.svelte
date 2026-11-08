<script lang="ts">
  // Contract stub (wave 2 agent B3 implements). Full-screen in-app camera that
  // appends every shutter press to `entryId` via repo.addPhotos.
  import type { Id, Photo } from '$lib/types'
  let {
    open = $bindable(false),
    entryId,
    oncaptured,
  }: { open?: boolean; entryId: Id; oncaptured?: (photos: Photo[]) => void } = $props()
  void entryId
  void oncaptured
</script>

{#if open}<div role="dialog" aria-label="Camera">Camera arrives in the next build.</div>{/if}
