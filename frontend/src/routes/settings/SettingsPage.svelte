<script lang="ts">
  import { onMount } from 'svelte'
  import { repo } from '$lib/db'
  import { SETTING_KEYS } from '$lib/types'
  import type { CaptureMode } from '$lib/camera'
  import type { StorageEstimate } from '$lib/repo'
  import Button from '../../components/ui/Button.svelte'

  let captureMode = $state<CaptureMode>('native')
  let storage = $state<StorageEstimate | null>(null)
  let storageMessage = $state('')

  onMount(() => {
    void (async () => {
      captureMode = await repo.getSetting<CaptureMode>(SETTING_KEYS.captureMode, 'native')
      storage = await repo.estimateStorage()
    })()
  })

  async function chooseMode(mode: CaptureMode) {
    captureMode = mode
    await repo.setSetting(SETTING_KEYS.captureMode, mode)
  }

  async function keepData() {
    const granted = await repo.requestPersistentStorage()
    storageMessage = granted
      ? 'The browser will keep this storage until you clear site data.'
      : 'The browser did not grant persistent storage.'
    storage = await repo.estimateStorage()
  }

  function formatBytes(value: number | null | undefined) {
    if (value == null) return 'Unavailable'
    if (value < 1024) return `${value} B`
    const units = ['KB', 'MB', 'GB', 'TB']
    let size = value
    let unit = -1
    do {
      size /= 1024
      unit++
    } while (size >= 1024 && unit < units.length - 1)
    return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`
  }
</script>

<svelte:head><title>Settings · Kufang Capture</title></svelte:head>
<section class="page settings-page">
  <div class="page-heading"><h1>Settings</h1></div>
  <section class="settings-card" aria-labelledby="capture-heading">
    <h2 id="capture-heading">Capture mode</h2>
    <fieldset>
      <label class="choice"
        ><input
          type="radio"
          name="capture-mode"
          checked={captureMode === 'native'}
          onchange={() => chooseMode('native')}
        /><span
          ><strong>System camera</strong><small>Best quality, opens iOS Camera for each photo</small></span
        ></label
      >
      <label class="choice"
        ><input
          type="radio"
          name="capture-mode"
          checked={captureMode === 'fast'}
          onchange={() => chooseMode('fast')}
        /><span
          ><strong>Fast camera</strong><small>Stays open for rapid shots; video-frame quality</small></span
        ></label
      >
    </fieldset>
  </section>
  <section class="settings-card" aria-labelledby="storage-heading">
    <h2 id="storage-heading">Storage on this device</h2>
    <dl>
      <div>
        <dt>Used</dt>
        <dd>{formatBytes(storage?.usage)}</dd>
      </div>
      <div>
        <dt>Available quota</dt>
        <dd>{formatBytes(storage?.quota)}</dd>
      </div>
      <div>
        <dt>Persistent storage</dt>
        <dd>{storage?.persisted == null ? 'Unavailable' : storage.persisted ? 'Enabled' : 'Not enabled'}</dd>
      </div>
    </dl>
    <Button variant="quiet" onclick={keepData}>Keep data on this device</Button>
    {#if storageMessage}<p class="storage-message" role="status">{storageMessage}</p>{/if}
  </section>
  <section class="settings-card app-info">
    <h2>About</h2>
    <p>Version {import.meta.env.VITE_APP_VERSION ?? 'dev'}</p>
    <a href="/diagnostics">Open Diagnostics</a>
  </section>
</section>

<style>
  .settings-page {
    max-width: 760px;
  }
  .settings-page > .page-heading {
    margin-bottom: 16px;
  }
  .settings-card {
    padding: 18px;
    margin-bottom: 12px;
    background: var(--color-card);
    border: 1px solid var(--color-line);
    border-radius: 8px;
  }
  .settings-card h2 {
    margin-bottom: 12px;
  }
  .settings-card fieldset {
    padding: 0;
    margin: 0;
    border: 0;
  }
  .choice {
    display: flex;
    gap: 12px;
    align-items: center;
    min-height: 64px;
    padding: 10px 4px;
    border-top: 1px solid var(--color-line);
    cursor: pointer;
  }
  .choice input {
    width: 20px;
    height: 20px;
    accent-color: var(--color-ballpoint);
  }
  .choice span {
    display: grid;
    gap: 2px;
  }
  .choice small {
    color: var(--color-muted);
  }
  dl {
    margin: 0 0 14px;
  }
  dl div {
    display: flex;
    justify-content: space-between;
    padding: 7px 0;
    border-bottom: 1px solid var(--color-line);
  }
  dt {
    color: var(--color-muted);
  }
  dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
  }
  .storage-message {
    color: var(--color-muted);
    margin-bottom: 0;
  }
  .app-info p {
    margin: 0 0 8px;
    color: var(--color-muted);
  }
</style>
