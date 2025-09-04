# Spawner API (Phase 1)

Tiny HTTP API that starts/stops/attaches to disposable CLI-agent containers
(Codex, Gemini, OpenCode) and streams logs while writing transcripts to the
workspace.

## Quick Start

1) Install deps

```
cd spawner
npm install
```

2) Configure (optional)

Copy `.env.example` to `.env` (see vars below). By default the API binds to
`127.0.0.1:8080` and uses image `cli-runner:latest`.

3) Run

```
npm start
```

Open the UI: http://127.0.0.1:8080/

## Environment variables

- `PORT` (default `8080`)
- `BIND_HOST` (default `127.0.0.1`)
- `CLI_RUNNER_IMAGE` (default `cli-runner:latest`)
- `IDLE_TIMEOUT_SEC` (default `900` seconds; set `0` to disable)
- `ALLOW_WORKSPACE_ROOTS` (comma-separated abs paths; default `./cli-runner/volumes/workspace`)
- `ALLOW_CREDS_ROOTS` (comma-separated abs paths; default `./cli-runner/volumes/creds`)

## API

- `POST /runs` → start a run

```
{
  "engine": "codex" | "gemini" | "opencode",
  "workspace": "/abs/path",
  "creds": "/abs/creds",
  "readOnly": true,
  "uidgid": "1000:1000",
  "extraEnv": { "OPENAI_API_KEY": "..." }
}
```

Returns `{ runId, containerName }`.

- `GET /runs` → list runs `{ runId, engine, workspace, status, startedAt }`
- `GET /runs/:id/logs?follow=1` → SSE stream of stdout (sends current transcript chunk, then follows)
- `POST /runs/:id/input` → `{ data: "text\n" }` (writes to TTY)
- `DELETE /runs/:id` → stop/remove container
- `GET /runs/:id/meta` → mounts, image tag, labels, transcript path
- `GET /runs/:id/artifacts` → transcripts and recent files under the workspace
- `GET /runs/:id/file?path=/abs/path` → stream a file (must be under workspace)
- `GET /events` → SSE event bus for run lifecycle and artifacts
- `GET /creds/check?engine=codex|gemini|opencode&creds=/abs/path` → readiness check
- `POST /creds/write-env` → `{ creds:"/abs/path", updates:{ KEY:"VALUE", ... } }` write to creds `.env`
- Warm pool:
  - `GET /warm` → list warm containers
  - `POST /warm/ensure` → ensure warm container for `{ engine, workspace, creds, readOnly?, uidgid? }`
  - `DELETE /warm/:id` → stop/remove warm container

## UI (Phase 2)

- Single-page UI at `/`:
  - New Runner modal: engine, workspace, creds, read-only toggle, use spawner UID:GID.
  - Runners list and status.
  - Runner detail with terminal/log stream (SSE) and input box to send keystrokes.
  - Stop and Kill buttons.
  - Artifacts panel: transcripts list and recent files (copy path or open).

## First-login Wizard (Phase 3)

- When starting a run, the UI calls `/creds/check` to determine readiness.
- If not ready:
  - Codex: prompt for `OPENAI_API_KEY` or “Start run now” to complete device login; tokens persist under `creds/codex`.
  - Gemini: prompt for `GEMINI_API_KEY`, or enable Vertex (`GOOGLE_GENAI_USE_VERTEXAI`), or “Start run now” for device login; tokens persist under `creds/gemini`.
  - OpenCode: prompt for provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`).
- Saved keys are written to `<creds>/.env` via `/creds/write-env`, auto-loaded by the image entrypoint.

## Warm Pool (Phase 4)

- UI: "Ensure Warm" starts a long-running idle container per engine (`sleep infinity`) for faster exec attach.
- New-run modal has a "Prefer warm pool" toggle. When enabled, Spawner tries to exec into a matching warm container and start `/entrypoint.sh` there; otherwise it creates a fresh container.
- Stopping a warm-backed run attempts a graceful exit without stopping the warm container. Kill targets the CLI process only (keeps warm container).

## QoL & Guardrails (Phase 5)

- Read-only root defaults ON for new runs (UI toggle to disable).
- Auto-idle timeout: set `IDLE_TIMEOUT_SEC` (default 900s). If no IO, Spawner auto-stops the run and appends a transcript note.
- Error surfacing: the UI detects auth errors in logs and prompts to open the credentials wizard.
 - Resource caps in Compose: use Make targets to run with light/standard/heavy cpus/mem limits.

## Board Integration (Phase 6)

Call the Spawner from your canvas tiles:

- Start: `POST /runs` with `{ engine, workspace, creds, readOnly?, uidgid?, preferWarm? }`.
- Attach logs: open SSE at `/runs/:id/logs?follow=1` and stream lines into your terminal widget.
- Send input: `POST /runs/:id/input` with `{ data: "text\n" }`.
- Stop: `DELETE /runs/:id` (keeps warm containers if used).
- Event bus: subscribe to `/events` (SSE) for structured events: `run-started`, `run-exited`, `run-stopped`, `run-killed`, `run-idle-stopped`, `artifact` (file/url/pr), `warning` (auth).
- Artifacts: show links from `artifact` events, or query `/runs/:id/artifacts`.

Client snippet (JS): see `spawner/examples/board-client.js`.

Acceptance checklist:
- `POST /runs` starts a container with correct mounts, labels, and writes a transcript file under `/workspace/.runs`.
- `GET /runs/:id/logs` streams output with low latency (SSE lines).
- `POST /runs/:id/input` writes to the container TTY.
- Stopping a run cleans up (warm mode keeps warm container, otherwise container is removed); workspace and creds remain intact.
- First-login wizard persists tokens/keys in the creds pocket; subsequent runs re-use.
- UI provides list, detail view with terminal, and New Runner modal.


## Notes

- The Spawner writes transcripts to `<workspace>/.runs/<engine>-<timestamp>.log` and streams the same to the client.
- The container is started with labels:
  - `adz.engine`, `adz.workspace`, `adz.creds`, `adz.runId`
- The image’s entrypoint auto-loads `/home/agent/.creds/.env` (mounted from your creds pocket), so you typically don’t need to pass secrets from the UI.
