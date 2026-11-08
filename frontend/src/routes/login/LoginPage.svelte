<script lang="ts">
  import { authClient } from '$lib/sync'
  import { navigate } from '../../app/router.svelte'
  import Button from '../../components/ui/Button.svelte'
  let password = $state('')
  let error = $state('')
  let busy = $state(false)
  const params = new URLSearchParams(location.search)
  const returnTo = params.get('return') || '/settings'
  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (busy || !password) return
    busy = true
    error = ''
    try {
      await authClient.login(password)
      navigate(returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/')
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not sign in.'
    } finally {
      busy = false
    }
  }
</script>

<svelte:head><title>Sign in · Kufang Capture</title></svelte:head>
<section class="page auth-page">
  <h1>Sign in</h1>
  <p>
    Sign in only when you want to Sync to Server or export synced data on a desktop. Local Only collections
    work without an account.
  </p>
  <form onsubmit={submit}>
    <label
      >Password<input type="password" bind:value={password} autocomplete="current-password" required /></label
    >
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <Button type="submit" disabled={busy || !password}>{busy ? 'Signing in…' : 'Sign in'}</Button>
  </form>
  <a href="/settings">Back to Settings</a>
</section>

<style>
  .auth-page {
    max-width: 520px;
    margin: 0 auto;
    padding: 24px 16px;
  }
  .auth-page form {
    display: grid;
    gap: 14px;
    margin: 24px 0;
  }
  .auth-page label {
    display: grid;
    gap: 6px;
  }
  .auth-page input {
    min-height: 48px;
    padding: 10px;
    border: 1px solid var(--color-line);
    border-radius: 6px;
    background: var(--color-card);
    color: var(--color-ink);
    font-size: 16px;
  }
  .auth-page p {
    line-height: 1.5;
  }
  .error {
    color: var(--color-danger);
  }
</style>
