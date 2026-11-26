<script lang="ts">
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
      error = cause instanceof Error ? cause.message : 'Could not sign in. Try again.'
    } finally {
      busy = false
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code)
      copyFeedback = 'Code copied.'
    } catch {
      copyFeedback = 'Select the code above and copy it.'
    }
  }
</script>

<svelte:head><title>Helper sign-in — Kufang Capture</title></svelte:head>
<section class="page auth-page">
  <h1>{inApp ? 'Open in Chrome or Safari' : 'Sign in as helper?'}</h1>
  {#if loaded && code}
    {#if inApp}
      <p>Copy this code, open Capture in Chrome or Safari, and choose Enter code.</p>
      <p class="join-code">{code}</p>
      <Button onclick={copyCode}>Copy code</Button>
      {#if copyFeedback}<p role="status">{copyFeedback}</p>{/if}
    {:else}
      <p>Use this one-time code to connect this browser to your Capture account.</p>
      <p class="join-code">{code}</p>
      {#if error}<p class="auth-error" role="alert">{error}</p>{/if}
      <Button disabled={busy} onclick={join}>{busy ? 'Signing in…' : 'Sign in as helper'}</Button>
      <a href="/login?mode=code">Enter another code</a>
    {/if}
  {:else if loaded}
    <p>This link is missing a valid sign-in code. Ask for a new link or enter your code.</p>
    {#if !inApp}<a href="/login?mode=code">Enter code</a>{/if}
  {/if}
  <LanguagePicker
    disabled={busy || !loaded}
    beforeReload={() => {
      // The join page removes the fragment after reading it. Restore it for this reload only.
      if (code) history.replaceState(history.state, '', location.pathname + location.search + '#' + code)
    }}
  />
</section>
