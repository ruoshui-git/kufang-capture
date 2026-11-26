<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'
  import { router } from './app/router.svelte'
  import { onMount } from 'svelte'
  // @ts-expect-error virtual module is supplied by vite-plugin-pwa at build time
  import { registerSW } from 'virtual:pwa-register'
  import { showToast } from './app/toasts.svelte'
  import SharePage from './routes/share/SharePage.svelte'
  import ToastHost from './components/ui/ToastHost.svelte'

  // Load the local-first shell only for app visits. Its routes construct the repository,
  // and mounting Layout starts account state and live IndexedDB subscriptions.
  async function loadAppPages() {
    const [layout, collections, entries, detail, settings, diagnostics, join, login, server] =
      await Promise.all([
        import('./app/Layout.svelte'),
        import('./routes/collections/CollectionsPage.svelte'),
        import('./routes/entries/EntryListPage.svelte'),
        import('./routes/detail/DetailPage.svelte'),
        import('./routes/settings/SettingsPage.svelte'),
        import('./routes/diagnostics/DiagnosticsPage.svelte'),
        import('./routes/join/JoinPage.svelte'),
        import('./routes/login/LoginPage.svelte'),
        import('./routes/server/ServerPage.svelte'),
      ])
    return {
      Layout: layout.default,
      CollectionsPage: collections.default,
      EntryListPage: entries.default,
      DetailPage: detail.default,
      SettingsPage: settings.default,
      DiagnosticsPage: diagnostics.default,
      JoinPage: join.default,
      LoginPage: login.default,
      ServerPage: server.default,
    }
  }

  let pages = $state.raw<Awaited<ReturnType<typeof loadAppPages>>>()

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
        showToast({ message: m.shell_offline_ready() })
      },
    })
    if (router.route.name === 'share') return

    let mounted = true
    let stop: (() => void) | undefined
    let removeShortcuts: (() => void) | undefined
    void Promise.all([
      loadAppPages(),
      import('$lib/sync'),
      import('./app/shortcuts'),
      import('$lib/camera'),
    ]).then(([loaded, { syncEngine }, { installKeyboardShortcuts }, { consumeInterruptedCamera }]) => {
      if (!mounted) return
      if (consumeInterruptedCamera()) showToast({ message: m.shell_camera_interrupted() })
      syncEngine.start()
      stop = () => syncEngine.stop?.()
      removeShortcuts = installKeyboardShortcuts(() =>
        window.dispatchEvent(new CustomEvent('capture: new-entry')),
      )
      pages = loaded
    })
    return () => {
      mounted = false
      stop?.()
      removeShortcuts?.()
    }
  })
</script>

{#if router.route.name === 'share'}
  <SharePage />
{:else if pages}
  {@const views = pages}
  <views.Layout>
    {#snippet children()}
      {#if router.route.name === 'collections'}<views.CollectionsPage />
      {:else if router.route.name === 'entries'}
        <!-- Keyed: one collection's search, filter and rows must never carry over to the next. -->
        {#key router.route.collectionId}<views.EntryListPage collectionId={router.route.collectionId} />{/key}
      {:else if router.route.name === 'detail'}
        {#if router.isDesktop}
          {#key router.route.collectionId}
            <views.EntryListPage
              collectionId={router.route.collectionId}
              detailEntryId={router.route.entryId}
            />
          {/key}
        {:else}
          <views.DetailPage
            collectionId={router.route.collectionId}
            entryId={router.route.entryId}
            variant="page"
          />
        {/if}
      {:else if router.route.name === 'settings'}<views.SettingsPage />
      {:else if router.route.name === 'diagnostics'}<views.DiagnosticsPage />
      {:else if router.route.name === 'login'}<views.LoginPage />
      {:else if router.route.name === 'join'}<views.JoinPage />
      {:else if router.route.name === 'server'}<views.ServerPage />
      {:else}<section class="page">
          <h1>{m.shell_page_not_found()}</h1>
          <p>{m.shell_page_not_found_description()}</p>
          <a href="/">{m.shell_back_to_collections()}</a>
        </section>{/if}
    {/snippet}
  </views.Layout>
{:else}
  <ToastHost />
{/if}
