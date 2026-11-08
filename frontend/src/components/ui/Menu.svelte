<script lang="ts">
  import type { Snippet } from 'svelte'
  let { children, label = 'More actions' }: { children: Snippet; label?: string } = $props()
</script>

<details class="menu">
  <summary aria-label={label} title={label}>⋯</summary>
  <div class="menu-popover" role="menu">{@render children()}</div>
</details>
