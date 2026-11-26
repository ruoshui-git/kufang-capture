import { defineConfig, devices } from '@playwright/test'
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

// End-to-end tests run the real stack: the production build served by the
// FastAPI backend (same origin, real SQLite and media storage in a throwaway
// directory). Chromium runs natively; WebKit (closest to iOS Safari) runs in
// the Playwright Docker image via `pnpm test:e2e:webkit`.
// The main checkout keeps port 8123; any other checkout (a worktree) gets its
// own stable port so parallel E2E runs never share a server. Workers inherit
// the choice through the environment.
const checkout = resolve(dirname(new URL(import.meta.url).pathname), '..')
const isMainCheckout = statSync(join(checkout, '.git'), { throwIfNoEntry: false })?.isDirectory() ?? false
const defaultPort = isMainCheckout
  ? 8123
  : 8200 + (createHash('sha256').update(checkout).digest().readUInt16BE(0) % 700)
process.env.E2E_PORT ??= String(defaultPort)
const port = Number(process.env.E2E_PORT)
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${port}`
const dataDir = process.env.E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), 'kc-e2e-'))
process.env.E2E_DATA_DIR = dataDir
const iphone = devices['iPhone 15 Pro Max']

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: { baseURL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    {
      name: 'iphone-chromium',
      use: {
        ...iphone,
        browserName: 'chromium',
        permissions: ['camera'],
        launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
      },
    },
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'android-chromium',
      use: {
        ...devices['Pixel 7'],
        permissions: ['camera'],
        launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
      },
    },
    { name: 'iphone-webkit', use: { ...iphone, browserName: 'webkit' } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command:
          `cd ../backend && CAPTURE_DATA_DIR=${dataDir} CAPTURE_STATIC_DIR=../frontend/dist ` +
          `CAPTURE_DEV_PASSWORD=dev CAPTURE_PUBLIC_ORIGIN=${baseURL} ` +
          `uv run uvicorn kufang_capture.main:app --host 127.0.0.1 --port ${port}`,
        url: `${baseURL}/api/health`,
        reuseExistingServer: false,
        timeout: 60_000,
      },
})
