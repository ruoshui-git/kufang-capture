<script lang="ts">
  let { children }: { children: import('svelte').Snippet } = $props()
</script>

<span class="chip">{@render children()}</span>
