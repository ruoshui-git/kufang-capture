<script lang="ts">
  let {
    children,
    variant = 'count',
  }: {
    children: import('svelte').Snippet
    variant?: 'count' | 'quantity' | 'status-ok' | 'status-warn' | 'status-danger'
  } = $props()
</script>

<span class="chip {variant}">{@render children()}</span>
