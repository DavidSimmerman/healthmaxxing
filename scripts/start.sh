#!/bin/sh
# Container entrypoint. Runs migrations, then starts the Claude sandbox sidecar and the app
# as two separate processes in this one container:
#   - sidecar: node agent/server.mjs on 127.0.0.1:8787 (internal only — never exposed)
#   - app:     node build on :3000 (the Coolify-proxied service)
# The app reaches the sidecar at AGENT_URL=http://127.0.0.1:8787. Keeping them in one
# container means no cross-service networking and it rides the app's zero-downtime deploy.
set -e

# Migrate first; a failure here exits the container rather than serving a stale schema.
node migrate.mjs

# Sidecar as a background process. It env-validates on boot (needs CLAUDE_CODE_OAUTH_TOKEN +
# AGENT_SECRET); if those are unset it exits and only the AI features are off — the app is
# unaffected. Backgrounded so a sidecar crash never takes the app down.
node agent/server.mjs &

# App in the foreground as PID 1's child; when it exits, the container exits.
exec node build
