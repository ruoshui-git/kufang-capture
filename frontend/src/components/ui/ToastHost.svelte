<script lang="ts">
  import { toasts, dismissToast } from '../../app/toasts.svelte'
</script>

<div class="toast-host" aria-live="polite" aria-relevant="additions removals">
  {#each toasts.items as toast (toast.id)}
    <div class="toast" role="status">
      <span>{toast.message}</span>{#if toast.action}<button
          type="button"
          onclick={() => {
            toast.action?.()
            dismissToast(toast.id)
          }}>{toast.actionLabel ?? 'Undo'}</button
        >{/if}<button
        type="button"
        class="toast-close"
        aria-label="Dismiss notification"
        onclick={() => dismissToast(toast.id)}>×</button
      >
    </div>
  {/each}
</div>
