# CLI Runner: Disposable CLI-Agent Container

This image bundles three terminal coding agents — Codex, Gemini, and OpenCode —
and a selector entrypoint. Each run mounts your host workspace and a
credentials pocket so tokens persist across new containers.

Contents:
- What's inside the image
- Build instructions
- First-run logins (one-time)
- Daily run examples
- Options: read-only root, host UID mapping
- Makefile shortcuts
- Docker Compose for parallel runners
- Spawner API (Phase 1)

## What's Inside
- Debian/Bookworm slim with Node 20, git, curl, bash, tini.
- CLIs preinstalled globally:
  - OpenAI Codex CLI (`@openai/codex`)
  - Google Gemini CLI (`@google/gemini-cli`)
  - OpenCode (`opencode-ai`)
- Non-root user `agent` (uid 1000).
- Entrypoint `/entrypoint.sh` selects engine via `ENGINE=codex|gemini|opencode`.
- Dot-configs symlink to mounted creds pocket:
  - `~/.codex` → `/home/agent/.creds/codex`
  - `~/.gemini` → `/home/agent/.creds/gemini`
  - `~/.opencode` → `/home/agent/.creds/opencode`
  - `~/.config/gcloud` → `/home/agent/.creds/gcloud`

## Build the Image

From repo root:

```
docker build -t cli-runner:latest cli-runner/docker
```

Or with Makefile:

```
make build IMAGE=cli-runner:latest
```

## Prepare Host Folders

```
mkdir -p cli-runner/volumes/workspace
mkdir -p cli-runner/volumes/creds/{codex,gemini,opencode,gcloud}
```

Or use your own absolute paths.

## First-Run Login (do once per user)

Run the launcher with your creds pocket mounted. Choose the engine you want to initialize.

Codex:
- Option A: Sign in with ChatGPT (device/browser flow). Tokens saved under `~/.codex`.
- Option B: Use `OPENAI_API_KEY` in host-launch/.env.

Gemini:
- Option A: OAuth device flow; token saved under `~/.gemini`.
- Option B: `GEMINI_API_KEY` from AI Studio.
- Option C: Vertex AI using ADC (`~/.config/gcloud` → `/home/agent/.creds/gcloud`) and `GOOGLE_GENAI_USE_VERTEXAI=true`.

OpenCode:
- Provide provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) via .env or let it prompt and cache in `~/.opencode`.

Key rule: perform logins with the creds pocket mounted so tokens persist.

## Daily Usage

Interactive launcher (prompts for engine):

```
./cli-runner/host-launch/run.sh
```

Explicit engine and paths:

```
./cli-runner/host-launch/run.sh \
  --engine codex \
  --workspace /abs/path/to/myapp \
  --creds /abs/path/to/creds/jane
```

The agent starts in `/workspace`. All file changes appear in your host folder.

## Makefile Shortcuts

- `make build` — build image (set `IMAGE=` to override tag)
- `make run` — run via launcher (set `ENGINE=codex|gemini|opencode`, `WORKSPACE=`, `CREDS=`)
- `make run-codex|run-gemini|run-opencode` — convenience wrappers

Examples:

```
make build IMAGE=cli-runner:latest
make run ENGINE=gemini WORKSPACE=$PWD/cli-runner/volumes/workspace CREDS=$PWD/cli-runner/volumes/creds
```

## Docker Compose (Parallel Runners)

Compose file at repo root defines three services: `codex`, `gemini`, `opencode`.

Start one service:

```
docker compose up codex
```

Start all three (different terminals):

```
docker compose up --build
```

Override mounts via env vars when invoking Compose:

```
CODEX_WORKSPACE=/abs/path/app1 CODEX_CREDS=/abs/path/creds/jane \
GEMINI_WORKSPACE=/abs/path/app2 GEMINI_CREDS=/abs/path/creds/alex \
OPENCODE_WORKSPACE=/abs/path/app3 OPENCODE_CREDS=/abs/path/creds/lee \
docker compose up --build
```

Makefile wrappers:

```
make compose-codex IMAGE=cli-runner:latest WORKSPACE=/abs/path/app CREDS=/abs/path/creds
make compose-up IMAGE=cli-runner:latest WORKSPACE=/abs/path/app CREDS=/abs/path/creds
make compose-down
```

Warm pool (Phase 4): start idle containers for faster attach via exec:

```
make compose-warm-up IMAGE=cli-runner:latest WORKSPACE=/abs/path/app CREDS=/abs/path/creds
# later
make compose-warm-down
```

## QoL & Guardrails (Phase 5)

- Read-only root: enabled by default for Compose services and new runs (toggle in UI for ad-hoc). A tmpfs `/tmp` is mounted for tools.
- Resource caps: use Make targets for profiles:
  - `make compose-up-light|compose-up-standard|compose-up-heavy` (sets `cpus` and `mem_limit` via env vars)
  - `make compose-warm-up-light|compose-warm-up-standard|compose-warm-up-heavy`
- Idle timeout: Spawner auto-stops runs after inactivity. Configure with `IDLE_TIMEOUT_SEC` (default 900s) in `spawner/.env`.
- Artifacts: UI shows transcripts (`/workspace/.runs`) and recent files; you can open transcripts in-browser.
- Auth assist: when logs contain common auth errors, UI offers an “Open Credentials” prompt to set keys.

## Spawner API (Phase 1)

Start a small host API to create/attach/stop runs, stream logs, and write transcripts.

Setup:

```
make spawner-install
make spawner-start IMAGE=cli-runner:latest
```

Defaults: binds to `127.0.0.1:8080`, image `cli-runner:latest`.

Allowed roots (security): set in `spawner/.env` → `ALLOW_WORKSPACE_ROOTS`, `ALLOW_CREDS_ROOTS`.

Example calls:

```
# Start a run
curl -sS -X POST http://127.0.0.1:8080/runs \
  -H 'content-type: application/json' \
  -d '{
    "engine":"codex",
    "workspace":"/abs/path/to/workspace",
    "creds":"/abs/path/to/creds",
    "readOnly":true,
    "uidgid":"1000:1000"
  }'

# List runs
curl http://127.0.0.1:8080/runs

# Stream logs (SSE)
curl -N http://127.0.0.1:8080/runs/<id>/logs?follow=1

# Send input to TTY
curl -sS -X POST http://127.0.0.1:8080/runs/<id>/input \
  -H 'content-type: application/json' -d '{"data":"help\\n"}'

# Stop/remove
curl -X DELETE http://127.0.0.1:8080/runs/<id>

# Meta
curl http://127.0.0.1:8080/runs/<id>/meta
```

## Environment Variables

Copy `cli-runner/host-launch/.env.example` to `cli-runner/host-launch/.env` and set any keys to pass through:

- `OPENAI_API_KEY` (Codex / OpenCode)
- `GEMINI_API_KEY` (Gemini AI Studio)
- `GOOGLE_GENAI_USE_VERTEXAI=true` and `GOOGLE_API_KEY` (Gemini via Vertex)
- `GOOGLE_APPLICATION_CREDENTIALS=/home/agent/.creds/gcloud/sa.json` (optional)
- `ANTHROPIC_API_KEY` (OpenCode)

Compose note: for `docker compose` runs, put the same vars in your creds pocket as `/home/agent/.creds/.env` on the host (i.e., create `${CREDS}/.env`). The entrypoint sources that file automatically.

## Options and Tips

- Read-only root FS: add `--read-only` to launcher (`--read-only` flag).
- File ownership on Linux: use `--user-current` to run as your host UID:GID.
- Extra docker run flags: set `EXTRA_DOCKER_RUN_ARGS` in `.env`.

## Troubleshooting

- If the CLI can’t write to `/workspace`, check mount permissions and add `--user-current` on Linux.
- If logins keep prompting each run, verify your creds mount path and that the engine’s dot-folder is symlinked (see banner on start).
- If a CLI isn’t found, ensure the image built successfully and the correct image tag is used.

## UI (Phase 2)

Open the Spawner UI:

```
http://127.0.0.1:8080/
```

Use the New Runner modal to start a container, view its live logs in the terminal, send input, and stop/kill. The UI uses SSE to stream logs and writes transcripts to `/workspace/.runs`.

## Warm Pool (Phase 4)

- You can pre-start warm containers per engine via Makefile `compose-warm-up` or from the UI (“Ensure Warm”).
- When "Prefer warm pool" is checked in the New Runner modal, the Spawner first tries to exec into a matching warm container (`sleep infinity`) and start the CLI, otherwise it creates a fresh container.
- Stopping a warm-backed run sends Ctrl-C/exit to the CLI but keeps the warm container alive. Kill terminates the CLI process inside the container and preserves the warm pool.

## Board Integration (Phase 6)

- Start a runner from a tile: `POST /runs` with `{ engine, workspace, creds, readOnly?, uidgid?, preferWarm? }`.
- Attach logs: SSE at `/runs/:id/logs?follow=1`.
- Send input: `POST /runs/:id/input` with `{ data: "...\n" }`.
- Stop: `DELETE /runs/:id`.
- Events bus: subscribe to `/events` (SSE) for lifecycle events and artifact hints (file/url/pr).
- Artifacts: list via `/runs/:id/artifacts` and open with `/runs/:id/file?path=...`.
- Minimal client example: `spawner/examples/board-client.js`.
