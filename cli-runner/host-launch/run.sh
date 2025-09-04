#!/usr/bin/env bash
set -euo pipefail

# Simple host launcher to run the disposable CLI-agent container.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)
REPO_ROOT=$(cd -- "${SCRIPT_DIR}/.." && pwd)

# Defaults
IMAGE=${CLI_RUNNER_IMAGE:-cli-runner:latest}
WORKSPACE="${REPO_ROOT}/volumes/workspace"
CREDS="${REPO_ROOT}/volumes/creds"
ENGINE=""
READ_ONLY_ROOT=false
USE_HOST_USER=false
EXTRA_ARGS=${EXTRA_DOCKER_RUN_ARGS:-}

# Load .env next to this script if present
if [ -f "${SCRIPT_DIR}/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${SCRIPT_DIR}/.env"
  set +a
fi

usage() {
  cat <<EOF
Usage: $(basename "$0") [options] [-- extra CLI args]

Options:
  -e, --engine <codex|gemini|opencode>  Engine to start
  -w, --workspace <path>                Host workspace path to mount
  -c, --creds <path>                    Host credentials pocket path to mount
  -i, --image <name:tag>                Docker image name (default: ${IMAGE})
      --read-only                       Run container with read-only root filesystem
      --user-current                    Run as current host UID:GID (Linux ownership)
  -h, --help                            Show this help

Environment variables (via host-launch/.env or shell):
  OPENAI_API_KEY, GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI,
  GOOGLE_API_KEY, ANTHROPIC_API_KEY, GOOGLE_APPLICATION_CREDENTIALS

Examples:
  $(basename "$0") --engine codex --workspace ~/projects/myapp --creds ~/adz/creds/jane
  $(basename "$0") -e gemini -w $(pwd) -c ~/.adz/creds -- --model gemini-2.0
EOF
}

prompt_engine() {
  echo "Select engine:"
  select choice in codex gemini opencode; do
    case $choice in
      codex|gemini|opencode) ENGINE=$choice; break ;;
      *) echo "Invalid choice" ;;
    esac
  done
}

ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -e|--engine) ENGINE="$2"; shift 2;;
    -w|--workspace) WORKSPACE="$2"; shift 2;;
    -c|--creds) CREDS="$2"; shift 2;;
    -i|--image) IMAGE="$2"; shift 2;;
    --read-only) READ_ONLY_ROOT=true; shift;;
    --user-current) USE_HOST_USER=true; shift;;
    -h|--help) usage; exit 0;;
    --) shift; ARGS+=("$@"); break;;
    *) echo "Unknown option: $1" >&2; usage; exit 1;;
  esac
done

if [[ -z "${ENGINE}" ]]; then
  prompt_engine
fi

mkdir -p "${WORKSPACE}"
mkdir -p "${CREDS}" "${CREDS}/"{codex,gemini,opencode,gcloud}

# Build env pass-throughs
ENV_VARS=(
  OPENAI_API_KEY
  GEMINI_API_KEY
  GOOGLE_GENAI_USE_VERTEXAI
  GOOGLE_API_KEY
  ANTHROPIC_API_KEY
  GOOGLE_APPLICATION_CREDENTIALS
)

ENV_FLAGS=()
for var in "${ENV_VARS[@]}"; do
  if [[ -n "${!var-}" ]]; then
    ENV_FLAGS+=(-e "$var=${!var}")
  fi
done

RUN_FLAGS=(
  --rm -it
  -e "ENGINE=${ENGINE}"
  -v "${WORKSPACE}:/workspace:rw"
  -v "${CREDS}:/home/agent/.creds:rw"
  --workdir /workspace
)

if $READ_ONLY_ROOT; then
  RUN_FLAGS+=(--read-only --tmpfs /tmp:rw,noexec,nosuid,size=256m)
fi

if $USE_HOST_USER; then
  RUN_FLAGS+=(--user "$(id -u):$(id -g)")
fi

if [[ -n "${EXTRA_ARGS}" ]]; then
  # shellcheck disable=SC2206
  EXTRA_SPLIT=(${EXTRA_ARGS})
  RUN_FLAGS+=("${EXTRA_SPLIT[@]}")
fi

echo "Launching ${IMAGE} with engine=${ENGINE}"
set -x
docker run "${RUN_FLAGS[@]}" "${ENV_FLAGS[@]}" "${IMAGE}" "${ARGS[@]}"
