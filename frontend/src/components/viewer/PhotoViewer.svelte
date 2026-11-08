<script lang="ts">
  // Contract stub (wave 2 agent B2 implements). Full-screen viewer over the
  // non-deleted photos of `entryId` (sort_order), opened at `startPhotoId`.
  import type { Id } from '$lib/types'
  let {
    open = $bindable(false),
    entryId,
    startPhotoId = null,
  }: { open?: boolean; entryId: Id; startPhotoId?: Id | null } = $props()


</script>

{#if open}<div role="dialog" aria-label="Photo viewer" data-entry={entryId} data-start={startPhotoId}>Viewer arrives in the next build.</div>{/if}
