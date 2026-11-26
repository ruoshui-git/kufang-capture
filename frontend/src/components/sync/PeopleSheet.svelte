<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
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
      ? m.account_people()
      : view.kind === 'name'
        ? view.person
          ? m.account_rename_person()
          : m.account_add_person()
        : view.kind === 'code'
          ? m.account_person_code_title({ name: view.person.name })
          : view.person.disabled
            ? m.account_enable_person_confirm({ name: view.person.name })
            : m.account_disable_person_confirm({ name: view.person.name }),
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
          ? m.account_people_connection()
          : cause instanceof Error
            ? cause.message
            : m.core_people_update_failed()
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
      <Button variant="quiet" disabled={busy} onclick={showList}>{m.account_people_back()}</Button>
    {/if}
    {#if error}<p class="auth-error" role="alert">{error}</p>{/if}
    {#if view.kind === 'list'}
      {#if !people.length && busy}<p role="status">{m.account_people_loading()}</p>{/if}
      {#if !people.length && error}
        <Button variant="quiet" onclick={() => run(async () => (people = await peopleClient.list()))}
          >{m.account_try_again()}</Button
        >
      {:else}
        <Button disabled={busy} onclick={() => editName()}>{m.account_add_person()}</Button>
      {/if}
      <ul class="people-list">
        {#each people as person (person.id)}
          <li>
            <h3>{person.is_owner && person.name === 'Owner' ? m.core_account_owner() : person.name}</h3>
            {#if person.is_owner && person.name !== 'Owner'}<p>
                {m.core_account_owner()}
              </p>{:else if person.disabled}<p>
                {m.account_person_disabled()}
              </p>{/if}
            <p>
              {m.account_person_counts({
                collections: m.account_collections({ count: person.rooms }),
                entries: m.account_entries({ count: person.entries }),
                photos: m.account_photos({ count: person.photos }),
              })}
            </p>
            <p>
              {person.missing_originals
                ? m.account_person_devices_missing({
                    devices: m.account_person_devices({ count: person.device_count }),
                    missing: person.missing_originals,
                  })
                : m.account_person_devices({ count: person.device_count })}
            </p>
            <div class="person-actions">
              {#if !person.is_owner && !person.disabled}
                <Button disabled={busy} onclick={() => issueCode(person)}>{m.account_sign_in_code()}</Button>
              {/if}
              <Button variant="quiet" disabled={busy} onclick={() => editName(person)}
                >{m.account_rename()}</Button
              >
              {#if !person.is_owner}
                <Button
                  variant="quiet"
                  disabled={busy}
                  onclick={() => {
                    error = ''
                    view = { kind: 'status', person }
                  }}
                >
                  {person.disabled ? m.account_enable() : m.account_disable()}
                </Button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {:else if view.kind === 'name'}
      <form onsubmit={saveName}>
        <label class="field"
          >{m.account_person_name()}<input
            bind:value={name}
            maxlength="80"
            autocomplete="off"
            required
          /></label
        >
        <Button type="submit" disabled={busy || !name.trim()}
          >{busy ? m.account_saving() : m.account_save()}</Button
        >
      </form>
    {:else if view.kind === 'code'}
      {@const person = view.person}
      {#if qr}
        <p>{m.account_qr_instructions()}</p>
        <svg
          class="qr-code"
          viewBox="0 0 {qr.size} {qr.size}"
          shape-rendering="crispEdges"
          role="img"
          aria-label={m.account_qr_accessible()}
        >
          <rect width={qr.size} height={qr.size} class="qr-background" />
          <path d={qr.path} class="qr-modules" />
        </svg>
        <p class="join-code">{view.code.code}</p>
        {@const [beforeTime, afterTime] = m.account_code_expiry({ time: '\0' }).split('\0')}
        <p>
          {beforeTime}<time datetime="PT{remaining}S"
            >{Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, '0')}</time
          >{afterTime}
        </p>
      {:else}
        <p role="status">{m.account_code_expired()}</p>
      {/if}
      <Button disabled={busy} onclick={() => issueCode(person)}>{m.account_new_code()}</Button>
    {:else}
      {@const person = view.person}
      <p>
        {person.disabled ? m.account_person_enable_hint() : m.account_person_disable_hint()}
      </p>
      <Button
        variant={person.disabled ? 'primary' : 'danger'}
        disabled={busy}
        onclick={() => changeStatus(person)}
      >
        {person.disabled
          ? m.account_enable_person({ name: person.name })
          : m.account_disable_person({ name: person.name })}
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
