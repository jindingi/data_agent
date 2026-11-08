# Electron architecture validation

This is a reusable architecture harness, not the product application or completion of its E2E acceptance plan. No real API key or model request is used here. The SDK smoke uses a deterministic faux provider but a real `createAgentSession`, native JSONL and event system.

## Run

From this directory, after preparing the sibling `validation/runtime` and `validation/pi` dependencies:

```sh
npm ci
npx electron-rebuild -f -w better-sqlite3
npm run build:renderer
npm test
npm run build:dir
npm run test:packaged
node check-packaged-resources.cjs
```

The exact dependency graph is in `package-lock.json`. The harness pins Electron 45.2.3, better-sqlite3 13.0.3, Playwright-core 1.65.0, electron-builder 26.18.0, React/React DOM 19.2.4 and Streamdown 2.7.1. Each run records the actual embedded Node and ABI in `report.versions`; rebuild SQLite for that Electron version. The sibling smoke module uses pi SDK 1.5.0.

This independent legacy harness displays its own window and writes its own `dist/`. For current product regression with hidden windows and isolated build artifacts, use the [testing guide](../../docs/testing-guide.md).

## Checks

`run.cjs` starts a real Electron window with an isolated userData and database, connects using Chromium CDP over loopback, and clicks DOM controls. It checks:

1. Browser DOM -> sandboxed preload -> Main IPC, real better-sqlite3 read/write, resource resolution, and safeStorage fake-key encryption/decryption with no plaintext in encrypted bytes.
2. A real utilityProcess imports pi SDK, creates a session, streams events over MessagePort -> Main -> preload -> DOM, writes three native messages and restores three messages. The packaged run loads the module and dependencies entirely from the `.app` Resources directory.
3. Streamdown renders partial bold/code-fence chunks followed by completion. Explicit application policies disable raw HTML, remote images and links in this probe; hostile fixtures produce no `<img>`, `<a>` or injected scripts and no external image request. This does not prove a future artifact URL handler or arbitrary Markdown configuration safe.
4. Two independent utilityProcess hosts stream correctly attributed events; a third task queues.
5. Stopping A starts C while B keeps writing.
6. SIGKILL of host C cleans its Python worker process group while B continues.
7. SIGKILL of Electron Main cleans B's Python worker process group. The runner asserts no further heartbeat writes for **10 seconds** and verifies the process group no longer exists.

`check-packaged-resources.cjs` runs the bundled Python, pandas, NumPy, Matplotlib and Seaborn from a `.app` path containing spaces, produces a Chinese chart using the bundled font with no missing-glyph warning, decodes the PNG, and runs the bundled rg/fd against a Chinese filename. Its `PATH=/nonexistent` excludes fallback to system Python/tools. This is runtime/resource verification, not a network-isolation test.

## Process ownership

Main keeps a **private pipe to a detached watchdog**. EOF is the primary Main-liveness signal, independent of PID reuse/zombie state. The watchdog also monitors its specific Host, ignores SIGHUP, logs diagnostics, and owns a dedicated Python worker process group; it sends group TERM, then group KILL. Preserve this ownership protocol when adapting the harness; an in-Host finally block cannot run after Host SIGKILL.

This validates normal cancellation and the tested Main/Host kill paths. It does not promise cleanup of intentionally escaped `setsid` descendants, a killed watchdog, kernel failure or all possible process races. Production should preserve the ownership/pipe protocol, maintain process records and add startup reconciliation; do not replace the watchdog with an in-Host `finally` block.

## Generated evidence (local only)

Per-run directories under `results/` contain `report.json`, CDP screenshot, Electron log, test database, native pi JSONL, worker/cleanup records and heartbeat files. Build logs and any local `results.json` summary are not required inputs and are not committed. `dist/mac-arm64/Data Agent Validation.app` is the unsigned local test application; signing/notarization and public distribution are not claimed.

The tests create temporary application state only under this directory's `results/`. They do not inspect real user sessions, CSVs or credentials. The safeStorage sentinel is synthetic. After running, check for leftover processes belonging to this validation directory. Reports, screenshots, databases, bundles and the .app are ignored; rebuild them from source after checkout.
