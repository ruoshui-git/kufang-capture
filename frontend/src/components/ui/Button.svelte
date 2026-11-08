<script lang="ts">
  import type { Snippet } from 'svelte'
  let {
    children,
    variant = 'primary',
    type = 'button',
    disabled = false,
    onclick,
  }: {
    children: Snippet
    variant?: 'primary' | 'ink' | 'capture' | 'quiet' | 'danger'
    type?: 'button' | 'submit'
    disabled?: boolean
    onclick?: (event: MouseEvent) => void
  } = $props()
</script>

<button class="button {variant}" {type} {disabled} {onclick}>{@render children()}</button>
