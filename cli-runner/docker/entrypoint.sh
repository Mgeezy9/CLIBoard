#!/usr/bin/env bash
set -euo pipefail

ENGINE=${ENGINE:-codex}
CREDS_DIR="${HOME}/.creds"

banner() {
  echo "========================================"
  echo " CLI Runner"
  echo " Engine : ${ENGINE}"
  echo " Workspace: /workspace"
  echo " Creds   : ${CREDS_DIR} (mounted)"
  echo "========================================"
}

ensure_dir() {
  mkdir -p "$1"
}

ensure_symlink() {
  local source_path="$1"   # e.g., /home/agent/.codex
  local target_path="$2"   # e.g., /home/agent/.creds/codex
  mkdir -p "$target_path"
  if [ -w "$(dirname "$source_path")" ]; then
    if [ -L "$source_path" ]; then : ;
    elif [ -e "$source_path" ]; then
      if [ -d "$source_path" ]; then
        if [ -n "$(ls -A "$source_path" 2>/dev/null || true)" ]; then
          cp -a "$source_path"/. "$target_path"/
        fi
        rm -rf "$source_path"
      else
        mv "$source_path" "$target_path"/
      fi
    fi
    ln -snf "$target_path" "$source_path"
  fi
}

load_env_if_present() {
  local env_file="$CREDS_DIR/.env"
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
}

main() {
  banner

  # Validate workspace
  ensure_dir /workspace
  if [ ! -w /workspace ]; then
    echo "Error: /workspace must be writable (check your mount)." >&2
    exit 1
  fi

  # Ensure creds pocket
  ensure_dir "$CREDS_DIR"

  # If HOME is read-only (due to read-only root FS), relocate HOME into the creds mount
  RUN_HOME="$HOME"
  HOME_WRITABLE=0
  # Test writability by trying to create a file directly in HOME directory
  if touch "$HOME/.rwtest" 2>/dev/null; then
    HOME_WRITABLE=1
    rm -f "$HOME/.rwtest" 2>/dev/null || true
  else
    RUN_HOME="$CREDS_DIR"
    export HOME="$RUN_HOME"
    export XDG_CONFIG_HOME="$HOME/.config"
    mkdir -p "$XDG_CONFIG_HOME"
  fi

  # Wire up config locations when HOME is writable; otherwise CLIs will write under $HOME (the creds mount)
  if [ "$HOME_WRITABLE" = "1" ]; then
    case "$ENGINE" in
      codex) ensure_symlink "$RUN_HOME/.codex" "$CREDS_DIR/codex" ;;
      gemini) ensure_symlink "$RUN_HOME/.gemini" "$CREDS_DIR/gemini" ;;
      opencode) ensure_symlink "$RUN_HOME/.opencode" "$CREDS_DIR/opencode" ;;
    esac
    ensure_dir "$RUN_HOME/.config"
    ensure_symlink "$RUN_HOME/.config/gcloud" "$CREDS_DIR/gcloud"
  else
    # HOME points at the creds mount; ensure expected subfolders exist
    mkdir -p "$HOME/.codex" "$HOME/.gemini" "$HOME/.opencode" "$HOME/.config/gcloud"
  fi

  # Seed skeletons on first run if empty
  if [ "$ENGINE" = "codex" ] && [ -f "/opt/cli-runner/skeletons/codex/config.toml" ]; then
    if [ "$HOME_WRITABLE" = "1" ] && [ ! -e "$RUN_HOME/.codex/config.toml" ]; then
      mkdir -p "$RUN_HOME/.codex" && cp "/opt/cli-runner/skeletons/codex/config.toml" "$RUN_HOME/.codex/"
    elif [ "$HOME_WRITABLE" != "1" ] && [ ! -e "$HOME/.codex/config.toml" ]; then
      mkdir -p "$HOME/.codex" && cp "/opt/cli-runner/skeletons/codex/config.toml" "$HOME/.codex/"
    fi
  fi
  if [ "$ENGINE" = "gemini" ] && [ -f "/opt/cli-runner/skeletons/gemini/settings.json" ]; then
    if [ "$HOME_WRITABLE" = "1" ] && [ ! -e "$RUN_HOME/.gemini/settings.json" ]; then
      mkdir -p "$RUN_HOME/.gemini" && cp "/opt/cli-runner/skeletons/gemini/settings.json" "$RUN_HOME/.gemini/"
    elif [ "$HOME_WRITABLE" != "1" ] && [ ! -e "$HOME/.gemini/settings.json" ]; then
      mkdir -p "$HOME/.gemini" && cp "/opt/cli-runner/skeletons/gemini/settings.json" "$HOME/.gemini/"
    fi
  fi

  # Load optional env from creds pocket
  load_env_if_present

  # Ensure opencode local bin on PATH
  export PATH="$HOME/.opencode/bin:$PATH"

  cd /workspace

  case "$ENGINE" in
    codex)
      echo "Starting Codex CLI..."
      exec codex "$@"
      ;;
    gemini)
      echo "Starting Gemini CLI..."
      exec gemini "$@"
      ;;
    opencode)
      echo "Starting OpenCode CLI..."
      exec opencode "$@"
      ;;
    *)
      echo "Unknown ENGINE: $ENGINE (expected: codex|gemini|opencode)" >&2
      exit 2
      ;;
  esac
}

main "$@"
