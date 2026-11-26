<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
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
          }}>{toast.actionLabel ?? m.account_undo()}</button
        >{/if}{#each toast.actions ?? [] as action}<button
          type="button"
          onclick={() => {
            void action.action()
            dismissToast(toast.id)
          }}>{action.label}</button
        >{/each}<button
        type="button"
        class="toast-close"
        aria-label={m.account_dismiss_notification()}
        onclick={() => dismissToast(toast.id)}>×</button
      >
    </div>
  {/each}
</div>
