<script lang="ts">
  import type { Snippet } from 'svelte'
  let {
    children,
    label,
    onclick,
    disabled = false,
  }: {
    children: Snippet
    label: string
    onclick?: (event: MouseEvent) => void
    disabled?: boolean
  } = $props()
</script>

<button class="icon-button" type="button" aria-label={label} title={label} {onclick} {disabled}
  >{@render children()}</button
>
