<script lang="ts">
  import type { Snippet } from 'svelte'
  let {
    children,
    label = 'More actions',
    triggerText,
    variant = 'default',
    active = false,
  }: {
    children: Snippet
    label?: string
    triggerText?: string
    variant?: 'default' | 'filter'
    active?: boolean
  } = $props()
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
    if ((event.target as Element | null)?.closest('[role="menuitem"], [role="menuitemradio"]')) open = false
  }
</script>

<details class="menu" class:filter-trigger={variant === 'filter'} bind:this={element} bind:open>
  <summary class:active aria-label={label} title={label}>
    {triggerText ?? '⋯'}
  </summary>
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="menu-popover" role="menu" tabindex="-1" onclick={chosen}>{@render children()}</div>
</details>

<style>
  .menu.filter-trigger summary {
    display: inline-flex;
    width: auto;
    min-width: var(--size-touch);
    height: auto;
    min-height: var(--size-touch);
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-pill);
    padding: var(--space-3) var(--space-4);
    background: var(--color-card);
    color: var(--color-ink);
    font-size: var(--text-md);
    line-height: var(--leading-body);
    white-space: nowrap;
  }

  .menu.filter-trigger summary.active {
    border-color: var(--color-ink);
    background: var(--color-ink);
    color: var(--color-floor);
  }

  .menu.filter-trigger .menu-popover {
    right: auto;
    left: 0;
  }
</style>
