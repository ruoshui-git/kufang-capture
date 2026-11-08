<script lang="ts">
  let {
    children,
    tone = 'muted',
  }: { children: import('svelte').Snippet; tone?: 'muted' | 'ok' | 'warn' | 'danger' | 'syncing' } = $props()
</script>

<span class="status-line {tone}"><span class="status-dot"></span>{@render children()}</span>
