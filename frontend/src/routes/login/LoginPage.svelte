<script lang="ts">
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
      const { authClient } = await import('$lib/sync')
      await authClient.login(password)
      navigate(returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/')
    } catch (cause) {
      // The auth client already words each failure for people (wrong password, too many attempts
      // with the wait time, server unreachable); show it as is.
      error = cause instanceof Error && cause.message ? cause.message : 'Could not sign in. Try again.'
    } finally {
      busy = false
    }
  }
</script>

<svelte:head><title>Sign in — Kufang Capture</title></svelte:head>
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
    padding: var(--space-6) var(--space-5);
  }
  .auth-page form {
    display: grid;
    gap: var(--space-4);
    margin: var(--space-6) 0;
  }
  .auth-page label {
    display: grid;
    gap: var(--space-2);
  }
  .auth-page input {
    min-height: 48px;
    padding: var(--space-3);
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md);
    background: var(--color-card);
    color: var(--color-ink);
    font-size: var(--text-lg);
  }
  .auth-page p {
    line-height: 1.5;
  }
  .error {
    color: var(--color-danger);
  }
</style>
