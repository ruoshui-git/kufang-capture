<script lang="ts">
  let { collectionId, entryId }: { collectionId: string; entryId: string } = $props()
</script>

<section class="page">
  <h1>Entry detail</h1>
  <p>Collection {collectionId} · Entry {entryId}</p>
  <p>Entry detail arrives in the next build.</p>
</section>
