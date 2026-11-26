<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { getLocale, isLocale } from '$lib/paraglide/runtime.js'
  import { saveLocale } from '$lib/i18n/locale'

  let {
    inline = false,
    disabled = false,
    beforeReload,
  }: { inline?: boolean; disabled?: boolean; beforeReload?: () => void } = $props()
  const current = getLocale()
  let failed = $state(false)

  function change(event: Event & { currentTarget: HTMLSelectElement }) {
    const locale = event.currentTarget.value
    if (!isLocale(locale) || locale === current) return
    if (!saveLocale(locale)) {
      event.currentTarget.value = current
      failed = true
      return
    }
    beforeReload?.()
    window.location.reload()
  }
</script>

<div class="language-picker" class:settings-row={inline}>
  <label class="field">
    {m.core_language()}
    <select value={current} {disabled} onchange={change}>
      <!-- i18n-ignore: The option is always written in its own language. -->
      <option value="en" lang="en">English</option>
      <option value="zh-CN" lang="zh-CN">简体中文</option>
    </select>
  </label>
  {#if failed}<p role="alert">{m.core_language_save_failed()}</p>{/if}
</div>

<style>
  .language-picker:not(.settings-row) {
    margin-block: var(--space-4);
  }

  .settings-row label {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }

  select {
    min-height: var(--size-touch);
    max-width: 100%;
    justify-self: start;
    padding-inline: var(--space-4);
    border: var(--border);
    border-radius: var(--radius-md);
    background: var(--color-card);
    color: var(--color-ink);
    font-size: var(--text-lg);
  }

  p {
    margin: var(--space-2) 0 0;
    color: var(--color-danger);
  }
</style>
