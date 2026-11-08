# Kufang Capture

Offline-first iPhone PWA for photographing and counting physical inventory, room by room.
Live at **https://capture.kufang.org** (single-operator; login is required only for server sync).

- Inline-editable Entry List with stable entry numbers (`#0001`), recent photo thumbnails,
  quantity/unit and notes per row.
- Every change is saved to the device first (IndexedDB). Each collection is either
  **Local Only** (never uploaded) or **Sync to Server** (explicit opt-in).
- Portable ZIP export with CSV, JSON and the original photo bytes.

Independent of ERPNext/Frappe. See [docs/spec.md](docs/spec.md) for the product specification,
[AGENTS.md](AGENTS.md) for development commands, and [docs/operations.md](docs/operations.md)
for deployment.

## Quick start (WSL2 / Linux)

```sh
cd frontend && pnpm install && pnpm dev        # http://127.0.0.1:5173
cd backend && uv sync && uv run uvicorn kufang_capture.main:app --reload --port 8000
```

License: MIT.
