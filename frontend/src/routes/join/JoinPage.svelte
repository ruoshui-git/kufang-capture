<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import LanguagePicker from '../../components/i18n/LanguagePicker.svelte'
  import { onMount } from 'svelte'
  import { navigate } from '../../app/router.svelte'
  import Button from '../../components/ui/Button.svelte'
  import { accountGate } from '$lib/sync/binding'
  import { isInAppBrowser, joinCodeFromHash } from '../login/joinCode'

  let code = $state('')
  let loaded = $state(false)
  let error = $state('')
  let copyFeedback = $state('')
  let busy = $state(false)
  const inApp = isInAppBrowser(navigator.userAgent)

  onMount(() => {
    code = joinCodeFromHash(location.hash)
    if (location.hash) history.replaceState(history.state, '', location.pathname + location.search)
    loaded = true
  })

  async function join() {
    if (!code || busy || inApp) return
    busy = true
    error = ''
    try {
      const { authClient } = await import('$lib/sync')
      await authClient.join(code)
      navigate(accountGate.current.kind === 'blocked' ? '/settings' : '/', { replace: true })
    } catch (cause) {
      error = cause instanceof Error ? cause.message : m.account_sign_in_failed()
    } finally {
      busy = false
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code)
      copyFeedback = m.account_code_copied()
    } catch {
      copyFeedback = m.account_code_select_copy()
    }
  }
</script>

<svelte:head><title>{m.account_helper_sign_in_title()}</title></svelte:head>
<section class="page auth-page">
  <h1>{inApp ? m.account_open_external_browser() : m.account_helper_sign_in_heading()}</h1>
  {#if loaded && code}
    {#if inApp}
      <p>{m.account_join_open_external()}</p>
      <p class="join-code">{code}</p>
      <Button onclick={copyCode}>{m.account_copy_code()}</Button>
      {#if copyFeedback}<p role="status">{copyFeedback}</p>{/if}
    {:else}
      <p>{m.account_join_connect()}</p>
      <p class="join-code">{code}</p>
      {#if error}<p class="auth-error" role="alert">{error}</p>{/if}
      <Button disabled={busy} onclick={join}
        >{busy ? m.account_signing_in() : m.account_helper_sign_in()}</Button
      >
      <a href="/login?mode=code">{m.account_another_code()}</a>
    {/if}
  {:else if loaded}
    <p>{m.account_invalid_join_link()}</p>
    {#if !inApp}<a href="/login?mode=code">{m.account_enter_code()}</a>{/if}
  {/if}
  <LanguagePicker
    disabled={busy || !loaded}
    beforeReload={() => {
      // The join page removes the fragment after reading it. Restore it for this reload only.
      if (code) history.replaceState(history.state, '', location.pathname + location.search + '#' + code)
    }}
  />
</section>
