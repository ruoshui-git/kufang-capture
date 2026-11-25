<script lang="ts">
  import { navigate } from '../../app/router.svelte'
  import Button from '../../components/ui/Button.svelte'
  import { accountGate } from '$lib/sync/binding'
  import { isInAppBrowser, normalizeJoinCode } from './joinCode'

  const params = new URLSearchParams(location.search)
  const returnTo = params.get('return') || '/settings'
  const inApp = isInAppBrowser(navigator.userAgent)
  let useCode = $state(params.get('mode') === 'code')
  let password = $state('')
  let code = $state('')
  let error = $state('')
  let busy = $state(false)

  function changeMode() {
    useCode = !useCode
    password = ''
    code = ''
    error = ''
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (busy || (useCode ? !code || inApp : !password)) return
    const validCode = useCode ? normalizeJoinCode(code) : ''
    if (useCode && !validCode) {
      error = 'Enter the eight-character sign-in code.'
      return
    }
    busy = true
    error = ''
    try {
      const { authClient } = await import('$lib/sync')
      if (useCode) await authClient.join(validCode)
      else await authClient.login(password)
      const destination = returnTo.startsWith('/') && !/^\/[\/\\]/.test(returnTo) ? returnTo : '/'
      navigate(accountGate.current.kind === 'blocked' ? '/settings' : destination)
    } catch (cause) {
      error = cause instanceof Error && cause.message ? cause.message : 'Could not sign in. Try again.'
    } finally {
      busy = false
    }
  }
</script>

<svelte:head><title>Sign in — Kufang Capture</title></svelte:head>
<section class="page auth-page">
  <h1>{useCode ? 'Enter code' : 'Sign in'}</h1>
  {#if useCode && inApp}
    <p>Open Capture in Chrome or Safari to enter your helper code.</p>
  {:else}
    {#if useCode}
      <p>Enter the one-time code from the Capture owner.</p>
    {:else}
      <p>Local Only collections work without an account.</p>
    {/if}
    <form onsubmit={submit}>
      {#if useCode}
        <label class="field">
          Sign-in code
          <input
            type="text"
            value={code}
            oninput={(event) => {
              code = event.currentTarget.value.replace(/[a-z]/g, (letter) => letter.toUpperCase())
              event.currentTarget.value = code
            }}
            autocomplete="one-time-code"
            autocapitalize="characters"
            spellcheck="false"
            enterkeyhint="go"
            placeholder="XXXX-XXXX"
            maxlength="128"
            required
          />
        </label>
      {:else}
        <label class="field"
          >Password<input
            type="password"
            bind:value={password}
            autocomplete="current-password"
            required
          /></label
        >
      {/if}
      {#if error}<p class="auth-error" role="alert">{error}</p>{/if}
      <Button type="submit" disabled={busy || !(useCode ? code : password)}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  {/if}
  <div class="auth-actions">
    <Button variant="quiet" disabled={busy} onclick={changeMode}>
      {useCode ? 'Use owner password' : 'Enter code'}
    </Button>
    <a href="/settings">Back to Settings</a>
  </div>
</section>
