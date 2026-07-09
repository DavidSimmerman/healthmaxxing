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

# Sidecar as a background restart loop: server.mjs has no uncaughtException handler, so a
# crash would otherwise leave the AI features dead until the next deploy. Gated on its
# required env (CLAUDE_CODE_OAUTH_TOKEN + AGENT_SECRET): unset means "feature off", not a
# 2s crash-restart storm. Backgrounded so a sidecar crash never takes the app down.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && [ -n "${AGENT_SECRET:-}" ]; then
	(until node agent/server.mjs; do
		echo "[start.sh] sidecar exited ($?), restarting in 2s" >&2
		sleep 2
	done) &
else
	echo "[start.sh] CLAUDE_CODE_OAUTH_TOKEN/AGENT_SECRET unset - sidecar disabled, AI features off" >&2
fi

# App in the foreground as PID 1's child; when it exits, the container exits.
# Deliberately NO SIGTERM trap here: on deploy Coolify SIGTERMs the app (below), which
# drains in-flight requests while the sidecar keeps serving them; when the app exits the
# container's namespace teardown reaps the sidecar loop. A trap would add nothing.
exec node build
