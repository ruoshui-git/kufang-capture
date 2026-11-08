<script lang="ts">
  import type { Snippet } from 'svelte'
  let { children, label = 'More actions' }: { children: Snippet; label?: string } = $props()
  let open = $state(false)
  let element: HTMLDetailsElement | undefined = $state()

  // An open menu closes on a tap anywhere else, on Escape, and once one of its items is chosen.
  $effect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (element && !element.contains(event.target as Node)) open = false
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      open = false
      element?.querySelector('summary')?.focus()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape)
    }
  })

  function chosen(event: MouseEvent) {
    if ((event.target as Element | null)?.closest('[role="menuitem"]')) open = false
  }
</script>

<details class="menu" bind:this={element} bind:open>
  <summary aria-label={label} title={label}>⋯</summary>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="menu-popover" role="menu" tabindex="-1" onclick={chosen}>{@render children()}</div>
</details>
