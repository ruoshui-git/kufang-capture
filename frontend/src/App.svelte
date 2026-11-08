<script lang="ts">
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
  import LoginPage from './routes/login/LoginPage.svelte'
  import ServerPage from './routes/server/ServerPage.svelte'
  import { syncEngine } from '$lib/sync'
  import { installKeyboardShortcuts } from './app/shortcuts'
  onMount(() => {
    syncEngine.start()
    const updateSW = registerSW({
      immediate: true,
      onNeedRefresh() {
        showToast({
          message: 'Update available',
          actionLabel: 'Reload',
          action: () => updateSW(true),
          persistent: true,
        })
      },
      onOfflineReady() {
        showToast({ message: 'Ready to work offline' })
      },
    })
    return installKeyboardShortcuts(() => window.dispatchEvent(new CustomEvent('capture:new-entry')))
  })
</script>

<Layout>
  {#snippet children()}
    {#if router.route.name === 'collections'}<CollectionsPage />
    {:else if router.route.name === 'entries'}<EntryListPage collectionId={router.route.collectionId} />
    {:else if router.route.name === 'detail'}
      {#if router.isDesktop}
        <EntryListPage collectionId={router.route.collectionId} detailEntryId={router.route.entryId} />
      {:else}
        <DetailPage collectionId={router.route.collectionId} entryId={router.route.entryId} variant="page" />
      {/if}
    {:else if router.route.name === 'settings'}<SettingsPage />
    {:else if router.route.name === 'diagnostics'}<DiagnosticsPage />
    {:else if router.route.name === 'login'}<LoginPage />
    {:else if router.route.name === 'server'}<ServerPage />
    {:else}<section class="page">
        <h1>Page not found</h1>
        <p>The address does not match a Kufang Capture page.</p>
        <a href="/">Back to Collections</a>
      </section>{/if}
  {/snippet}
</Layout>
