# Build and runtime configuration

From a checkout of this release, run `./deployment/prepare-frontend.sh`, then `cd deployment` and `docker compose build`. The containers use the same isolated network and resource limits as the deployment; ports are not published. Nginx terminates TLS. Adapt the example vhost/domain and the matching allowedOrigin, WebSocket URL and origin check for your hostname.

Provide a private `secrets/` directory: access-policy.json (v5 schema shown in access-policy.example.json), auth-password-hashes.json (PBKDF2-SHA256), turn-key-hashes.json, shortlinks.json, obs-viewers.json and twilio.json. The latter contains your own Twilio accountSid/apiKeySid/apiKeySecret. No production data is included. JSON maps have version 1. Inspect turn-broker/server.js for the complete validation and session formats. Use scripts/room_wire_id.py to derive room wire IDs and stream suffix from your hostname and the frontend default password. Replace every placeholder in the example policy; talk stream IDs have the form ProdTalk plus 24 hex digits.

The scripts directory contains the original provisioning and migration code. Migration scripts are historical and are not an unattended fresh-install sequence; read their version checks first. Initial shortlink and OBS maps may be empty {"version":1,"links":{}} while you configure your own accounts and invitations. Credentials and map files must be readable by UID 10001; session-state must be writable by UID 10001. Keep them outside the frontend source directory and outside Git.

The source files use no frontend build step. Node and Caddy are pinned in the Dockerfiles. The signaling dependency ws is pinned in package-lock.json and its exact MIT-licensed source is included in vendor/ws. The original registry integrity hash is retained.

Source releases must be published before deploying changed code. scripts/verify-public-source.py verifies the runtime files against source-release.json, and deploy.sh runs it before recreating containers. Refresh that manifest only for a reviewed, published release.

The public Nginx and Compose files are examples: deployment-specific hostnames, certificate paths and bridge addresses are replaced with video.example.org and a sample 172.30.201.176/29 subnet. They are not the private production vhost. Update these settings consistently for your own installation.

## Sessions and access administration

Open /production-access and log in as Production. Select Joker and/or Creator accounts, confirm the change, and save the displayed list. The passwords are shown only once. Host/Production/Director credentials and other environments cannot be changed from this page. The old server-only access list does not update after rotations; use the newly downloaded list. Overrides are hashed only, persisted in session-state/credentials.json, and must be kept in backups along with sessions.json. Never copy session-state into the frontend or Git.

The nginx auth subrequest forwards the hashed session identifier to the private signaling server. Signaling polls turn-broker:8080/internal/active-sessions over the existing isolated bridge. Do not expose the broker or this internal endpoint directly. AUTH_BROKER_URL can configure the internal broker address. ALLOWED_ORIGIN configures the trusted browser origin in the two server components; it defaults to the production public hostname. BIND_HOST is optional for broker test fixtures; its container default is 0.0.0.0. No new public ports or writable secret mounts are required.

Reload all participant/Director pages and OBS browser sources once after deployment so receiver-side media revocation is active. Normal device changes remain supported: the latest login wins, and an older page cannot automatically reclaim that login. A person who still knows an unchanged password can log in again; rotate credentials after each event. Password rotation does not revoke already-issued third-party TURN credentials before their provider TTL.

Run the integration test with Node 24 and ws available on NODE_PATH: node deployment/tests/access-security.integration.js. It spawns only loopback fixture servers, uses generated temporary secrets, and removes them afterward.
