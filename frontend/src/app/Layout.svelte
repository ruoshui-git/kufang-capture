<script lang="ts">
  import type { Snippet } from 'svelte'
  import { router } from './router.svelte'
  import { repo } from '$lib/db'
  import { onMount } from 'svelte'
  import ToastHost from '../components/ui/ToastHost.svelte'
  import Badge from '../components/ui/Badge.svelte'
  import type { CollectionSummary } from '$lib/types'
  let { children, header, bottomBar }: { children: Snippet; header?: Snippet; bottomBar?: Snippet } = $props()
  let collections = $state<CollectionSummary[]>([])
  onMount(() => {
    const subscription = repo
      .watchCollectionSummaries({ includeArchived: false })
      .subscribe((items) => (collections = items))
    return () => (typeof subscription === 'function' ? subscription() : subscription.unsubscribe())
  })
</script>

<div class="app-layout">
  {#if router.isDesktop}
    <aside class="rail" aria-label="Collections">
      <a class="rail-title" href="/">Collections</a>
      {#each collections as item (item.collection.id)}
        <a class="rail-row" href="/c/{item.collection.id}"
          ><span class="rail-row-copy"
            ><span>{item.collection.name}</span><Badge mode={item.collection.storage_mode} /></span
          ><span>{item.entry_count}</span></a
        >
      {/each}
      <a class="rail-new" href="/?new=1">+ New collection</a>
    </aside>
  {/if}
  <div class="app-main">
    {#if header}<header class="app-header">{@render header()}</header>{/if}
    <main>{@render children()}</main>
    {#if bottomBar}<div class="bottom-action">{@render bottomBar()}</div>{/if}
  </div>
  <ToastHost />
</div>
