<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import Layout from './app/Layout.svelte'
  import { router } from './app/router.svelte'
  import { onMount } from 'svelte'
  // @ts-expect-error virtual module is supplied by vite-plugin-pwa at build time
  import { registerSW } from 'virtual:pwa-register'
  import { showToast } from './app/toasts.svelte'
  import CollectionsPage from './routes/collections/CollectionsPage.svelte'
  import EntryListPage from './routes/entries/EntryListPage.svelte'
  import DetailPage from './routes/detail/DetailPage.svelte'
  import SettingsPage from './routes/settings/SettingsPage.svelte'
  import DiagnosticsPage from './routes/diagnostics/DiagnosticsPage.svelte'
  import JoinPage from './routes/join/JoinPage.svelte'
  import LoginPage from './routes/login/LoginPage.svelte'
  import ServerPage from './routes/server/ServerPage.svelte'
  import { installKeyboardShortcuts } from './app/shortcuts'
  import { consumeInterruptedCamera } from '$lib/camera'
  import SharePage from './routes/share/SharePage.svelte'

  onMount(() => {
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        showToast({
          message: m.shell_update_available(),
          actionLabel: m.shell_reload(),
          action: () => updateSW(true),
          persistent: true,
        })
      },
      onOfflineReady() {
        // The shared page always reads the server, so "ready to work offline" would mislead a visitor.
        if (router.route.name !== 'share') showToast({ message: m.shell_offline_ready() })
      },
    })
    // A share visit renders outside Layout, with no local subscriptions or sync startup.
    if (router.route.name === 'share') return

    if (consumeInterruptedCamera()) showToast({ message: m.shell_camera_interrupted() })
    let mounted = true
    let stopSync: (() => void) | undefined
    void import('$lib/sync')
      .then(({ syncEngine }) => {
        if (!mounted) return
        syncEngine.start()
        stopSync = () => syncEngine.stop?.()
      })
      .catch(() => {})
    const removeShortcuts = installKeyboardShortcuts(() =>
      window.dispatchEvent(new CustomEvent('capture: new-entry')),
    )
    return () => {
      mounted = false
      stopSync?.()
      removeShortcuts()
    }
  })
</script>

{#if router.route.name === 'share'}
  <SharePage />
{:else}
  <Layout>
    {#snippet children()}
      {#if router.route.name === 'collections'}<CollectionsPage />
      {:else if router.route.name === 'entries'}
        <!-- Keyed: one collection's search, filter and rows must never carry over to the next. -->
        {#key router.route.collectionId}<EntryListPage collectionId={router.route.collectionId} />{/key}
      {:else if router.route.name === 'detail'}
        {#if router.isDesktop}
          {#key router.route.collectionId}
            <EntryListPage collectionId={router.route.collectionId} detailEntryId={router.route.entryId} />
          {/key}
        {:else}
          <DetailPage
            collectionId={router.route.collectionId}
            entryId={router.route.entryId}
            variant="page"
          />
        {/if}
      {:else if router.route.name === 'settings'}<SettingsPage />
      {:else if router.route.name === 'diagnostics'}<DiagnosticsPage />
      {:else if router.route.name === 'login'}<LoginPage />
      {:else if router.route.name === 'join'}<JoinPage />
      {:else if router.route.name === 'server'}<ServerPage />
      {:else}<section class="page">
          <h1>{m.shell_page_not_found()}</h1>
          <p>{m.shell_page_not_found_description()}</p>
          <a href="/">{m.shell_back_to_collections()}</a>
        </section>{/if}
    {/snippet}
  </Layout>
{/if}
