<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'

  let { url }: { url: string } = $props()
</script>

<div class="copy-fallback">
  <p role="status">{m.share_copy_failed()}</p>
  <label class="field">
    {m.share_link_url()}
    <input value={url} readonly onfocus={(event) => event.currentTarget.select()} />
  </label>
</div>

<style>
  .copy-fallback {
    display: grid;
    gap: var(--space-3);
    width: 100%;
    min-width: 0;
  }
  p {
    margin: 0;
  }
  input {
    min-width: 0;
  }
</style>
