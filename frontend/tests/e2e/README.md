# End-to-end tests

Real stack: `pnpm build` output served by the FastAPI backend with a throwaway data directory
(`E2E_DATA_DIR`, default a new temp dir per run), dev password `dev`.

```sh
pnpm build                                   # the tests use dist/
pnpm test:e2e                                # Chromium (iPhone 15 Pro Max emulation + desktop)
pnpm test:e2e:webkit                         # WebKit in the Playwright Docker image (closest to iOS)
E2E_BASE_URL=https://capture.kufang.org pnpm exec playwright test smoke   # live smoke only
```

Emulation is not a real iPhone: camera hardware, installed-PWA behaviour, storage eviction and
interruptions must still be verified on the device (docs/iphone-test-checklist.md).
