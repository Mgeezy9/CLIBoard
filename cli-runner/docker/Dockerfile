FROM node:20-bookworm-slim

# Install core tools and tini
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    curl \
    bash \
    tini \
    openssh-client \
 && rm -rf /var/lib/apt/lists/*

# Create non-root user (avoid UID collision with base image)
RUN if ! id -u agent >/dev/null 2>&1; then useradd -m -s /bin/bash agent; fi \
 && mkdir -p /workspace /home/agent/.creds \
 && chown -R agent:agent /workspace /home/agent

# Install the CLIs globally
# - OpenAI Codex CLI
# - Google Gemini CLI
# - OpenCode CLI
RUN npm i -g @openai/codex @google/gemini-cli opencode-ai \
 && npm cache clean --force

# Copy entrypoint and skeleton configs
COPY entrypoint.sh /entrypoint.sh
COPY skeletons /opt/cli-runner/skeletons
RUN chmod +x /entrypoint.sh \
 && chown -R agent:agent /opt/cli-runner

ENV HOME=/home/agent \
    SHELL=/bin/bash \
    PATH=/home/agent/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

WORKDIR /workspace

USER agent

ENTRYPOINT ["/usr/bin/tini","--","/entrypoint.sh"]
