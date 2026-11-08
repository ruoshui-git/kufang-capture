<script lang="ts">
  import type { Snippet } from 'svelte'
  import { tick } from 'svelte'
  let {
    open = $bindable(false),
    title,
    children,
    onclose,
  }: { open?: boolean; title: string; children: Snippet; onclose?: () => void } = $props()
  let dialog: HTMLDialogElement
  $effect(() => {
    if (open && dialog && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal()
      else dialog.setAttribute('open', '')
      tick().then(() => dialog.querySelector<HTMLElement>('input, button, [tabindex="0"]')?.focus())
    } else if (!open && dialog?.open) dialog.close()
  })
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
      return
    }
    if (event.key !== 'Tab') return
    const controls = [
      ...dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
      ),
    ]
    if (!controls.length) return
    const first = controls[0]!
    const last = controls[controls.length - 1]!
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  function close() {
    open = false
    onclose?.()
  }
</script>

<dialog
  bind:this={dialog}
  class="sheet"
  aria-label={title}
  onkeydown={handleKeydown}
  onclose={() => {
    if (open) close()
  }}
>
  <div class="sheet-head">
    <h2>{title}</h2>
    <button type="button" class="quiet-link" onclick={close}>Close</button>
  </div>
  {@render children()}
</dialog>
