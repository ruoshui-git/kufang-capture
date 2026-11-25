<script lang="ts">
  import { onMount } from 'svelte'
  import type { JoinCode, Person } from '$lib/sync/api'
  import { peopleClient } from '$lib/sync/clients'
  import Button from '../ui/Button.svelte'
  import Sheet from '../ui/Sheet.svelte'
  import { joinQr } from './joinQr'

  let { open = $bindable(false) }: { open?: boolean } = $props()
  type View =
    | { kind: 'list' }
    | { kind: 'name'; person?: Person }
    | { kind: 'code'; person: Person; code: JoinCode }
    | { kind: 'status'; person: Person }

  let view = $state<View>({ kind: 'list' })
  let people = $state<Person[]>([])
  let name = $state('')
  let busy = $state(false)
  let error = $state('')
  let now = $state(Date.now())
  const remaining = $derived(
    view.kind === 'code' ? Math.max(0, Math.ceil((Date.parse(view.code.expires_at) - now) / 1000)) : 0,
  )
  const qr = $derived(view.kind === 'code' && remaining > 0 ? joinQr(view.code.url) : null)
  const title = $derived(
    view.kind === 'list'
      ? 'People'
      : view.kind === 'name'
        ? view.person
          ? 'Rename person'
          : 'Add person'
        : view.kind === 'code'
          ? `Sign-in code for ${view.person.name}`
          : `${view.person.disabled ? 'Enable' : 'Disable'} ${view.person.name}?`,
  )

  onMount(() => {
    void run(async () => (people = await peopleClient.list()))
  })

  $effect(() => {
    if (view.kind !== 'code') return
    const timer = setInterval(() => (now = Date.now()), 1000)
    return () => clearInterval(timer)
  })

  async function run(action: () => Promise<unknown>) {
    if (busy) return
    busy = true
    error = ''
    try {
      await action()
    } catch (cause) {
      error =
        cause instanceof TypeError
          ? "Couldn't connect to the server. Try again."
          : cause instanceof Error
            ? cause.message
            : 'Could not update People. Try again.'
    } finally {
      busy = false
    }
  }

  function showList() {
    error = ''
    view = { kind: 'list' }
  }

  function editName(person?: Person) {
    name = person?.name ?? ''
    error = ''
    view = { kind: 'name', person }
  }

  function saveName(event: SubmitEvent) {
    event.preventDefault()
    if (view.kind !== 'name' || !name.trim()) return
    const person = view.person
    void run(async () => {
      const saved = person
        ? await peopleClient.update(person.id, { name: name.trim() })
        : await peopleClient.create(name.trim())
      people = person ? people.map((row) => (row.id === saved.id ? saved : row)) : [...people, saved]
      showList()
    })
  }

  function issueCode(person: Person) {
    void run(async () => {
      const code = await peopleClient.issueCode(person.id)
      now = Date.now()
      view = { kind: 'code', person, code }
    })
  }

  function changeStatus(person: Person) {
    void run(async () => {
      const saved = await peopleClient.update(person.id, { disabled: !person.disabled })
      people = people.map((row) => (row.id === saved.id ? saved : row))
      showList()
    })
  }
</script>

<Sheet bind:open {title}>
  <div class="people-sheet">
    {#if view.kind !== 'list'}
      <Button variant="quiet" disabled={busy} onclick={showList}>Back to People</Button>
    {/if}
    {#if error}<p class="auth-error" role="alert">{error}</p>{/if}
    {#if view.kind === 'list'}
      {#if !people.length && busy}<p role="status">Loading People…</p>{/if}
      {#if !people.length && error}
        <Button variant="quiet" onclick={() => run(async () => (people = await peopleClient.list()))}
          >Try again</Button
        >
      {:else}
        <Button disabled={busy} onclick={() => editName()}>Add person</Button>
      {/if}
      <ul class="people-list">
        {#each people as person (person.id)}
          <li>
            <h3>{person.name}</h3>
            {#if person.is_owner && person.name !== 'Owner'}<p>Owner</p>{:else if person.disabled}<p>
                Disabled
              </p>{/if}
            <p>
              {person.rooms}
              {person.rooms === 1 ? 'collection' : 'collections'} · {person.entries}
              {person.entries === 1 ? 'entry' : 'entries'} · {person.photos}
              {person.photos === 1 ? 'photo' : 'photos'}
            </p>
            <p>
              {person.device_count}
              {person.device_count === 1 ? 'device' : 'devices'}{#if person.missing_originals}
                · {person.missing_originals} missing originals{/if}
            </p>
            <div class="person-actions">
              {#if !person.is_owner && !person.disabled}
                <Button disabled={busy} onclick={() => issueCode(person)}>Sign-in code</Button>
              {/if}
              <Button variant="quiet" disabled={busy} onclick={() => editName(person)}>Rename</Button>
              {#if !person.is_owner}
                <Button
                  variant="quiet"
                  disabled={busy}
                  onclick={() => {
                    error = ''
                    view = { kind: 'status', person }
                  }}
                >
                  {person.disabled ? 'Enable' : 'Disable'}
                </Button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {:else if view.kind === 'name'}
      <form onsubmit={saveName}>
        <label class="field">Name<input bind:value={name} maxlength="80" autocomplete="off" required /></label
        >
        <Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save'}</Button>
      </form>
    {:else if view.kind === 'code'}
      {@const person = view.person}
      {#if qr}
        <p>Scan the QR code, or open Capture and choose Enter code.</p>
        <svg
          class="qr-code"
          viewBox="0 0 {qr.size} {qr.size}"
          shape-rendering="crispEdges"
          role="img"
          aria-label="QR code for helper sign-in"
        >
          <rect width={qr.size} height={qr.size} class="qr-background" />
          <path d={qr.path} class="qr-modules" />
        </svg>
        <p class="join-code">{view.code.code}</p>
        <p>
          Expires in <time datetime="PT{remaining}S"
            >{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</time
          > · One use
        </p>
      {:else}
        <p role="status">This code has expired. Make a new code to sign in.</p>
      {/if}
      <Button disabled={busy} onclick={() => issueCode(person)}>New code</Button>
    {:else}
      {@const person = view.person}
      <p>
        {person.disabled
          ? 'This person will be able to sign in with a new code.'
          : 'This will sign this person out on all devices and cancel their active code.'}
      </p>
      <Button
        variant={person.disabled ? 'primary' : 'danger'}
        disabled={busy}
        onclick={() => changeStatus(person)}
      >
        {person.disabled ? 'Enable' : 'Disable'}
        {person.name}
      </Button>
    {/if}
  </div>
</Sheet>

<style>
  .people-sheet {
    display: grid;
    justify-items: start;
    gap: var(--space-4);
  }
  .people-sheet p,
  .people-sheet h3 {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .people-sheet form,
  .people-list,
  .people-list li {
    display: grid;
    width: 100%;
    gap: var(--space-3);
  }
  .people-list {
    padding: 0;
    margin: 0;
    list-style: none;
  }
  .people-list li {
    border-top: var(--border);
    padding-top: var(--space-4);
  }
  .people-list li p {
    color: var(--color-muted);
  }
  .person-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  .qr-code {
    display: block;
    width: min(var(--size-join-qr), 100%);
    aspect-ratio: 1;
  }
  .qr-background {
    fill: var(--color-qr-background);
  }
  .qr-modules {
    fill: var(--color-qr-modules);
  }
  time {
    font-variant-numeric: tabular-nums;
  }
</style>
