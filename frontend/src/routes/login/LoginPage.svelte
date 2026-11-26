<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import LanguagePicker from '../../components/i18n/LanguagePicker.svelte'
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
      error = m.account_code_length()
      return
    }
    busy = true
    error = ''
    try {
      const { authClient } = await import('$lib/sync')
      if (useCode) await authClient.join(validCode)
      else await authClient.login(password)
      const destination = returnTo.startsWith('/') && !/^\/[/\\]/.test(returnTo) ? returnTo : '/'
      navigate(accountGate.current.kind === 'blocked' ? '/settings' : destination)
    } catch (cause) {
      error = cause instanceof Error && cause.message ? cause.message : m.account_sign_in_failed()
    } finally {
      busy = false
    }
  }
</script>

<svelte:head><title>{m.account_login_title()}</title></svelte:head>
<section class="page auth-page">
  <h1>{useCode ? m.account_enter_code() : m.account_sign_in()}</h1>
  {#if useCode && inApp}
    <p>{m.account_login_in_app()}</p>
  {:else}
    {#if useCode}
      <p>{m.account_login_one_time()}</p>
    {:else}
      <p>{m.account_local_works_signed_out()}</p>
    {/if}
    <form onsubmit={submit}>
      {#if useCode}
        <label class="field">
          {m.account_sign_in_code()}
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
            placeholder={m.account_code_placeholder()}
            maxlength="128"
            required
          />
        </label>
      {:else}
        <label class="field"
          >{m.account_password()}<input
            type="password"
            bind:value={password}
            autocomplete="current-password"
            required
          /></label
        >
      {/if}
      {#if error}<p class="auth-error" role="alert">{error}</p>{/if}
      <Button type="submit" disabled={busy || !(useCode ? code : password)}>
        {busy ? m.account_signing_in() : m.account_sign_in()}
      </Button>
    </form>
  {/if}
  <div class="auth-actions">
    <Button variant="quiet" disabled={busy} onclick={changeMode}>
      {useCode ? m.account_owner_password() : m.account_enter_code()}
    </Button>
    <a href="/settings">{m.account_back_settings()}</a>
  </div>
  <LanguagePicker disabled={busy || !!password || !!code} />
</section>
