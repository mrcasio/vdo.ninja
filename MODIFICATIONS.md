# Modification notice

Modified by easyCube between 2026-09-24 and 2026-11-01.
Frontend base: steveseguin/vdo.ninja d5a8b5669d1cb0ff75f984499f7025b745657808.
Signaling base: steveseguin/websocket_server 92d9bce4f8c798b520cfd2781d6f7f8ae607b3fb.

Changes include show branding and readable chat/settings, account display/logout, authenticated entry, private WebSocket signaling, Twilio token brokering, fixed participant slots, three isolated rooms, room-specific co-director return publishers, main Production Director, audio-only Production-Talk participation, scoped shortlinks, unauthenticated single-source OBS viewers, 24-hour sessions, and Director-controlled initial gain. Runtime authorization and links remain private configuration.

The October 31 source release adds license/source notices, current signaling source publication, complete build material and a deploy check. It does not change media routing, room permissions, audio gain or bitrate behavior.

The entire modified software is offered under AGPL-3.0, with upstream copyright and third-party notices retained. ws is MIT licensed; source and license are bundled in deployment/vendor/ws. Show logos and favicons are separately owned branding assets; software licensing grants no trademark rights.

## Access-security release, 2026-10-31

The latest successful login wins for each fixed participant account (guest, Creator or Host). A new device replaces the old login; reconnecting the current login replaces an older socket from the same login. Main Production and co-director accounts retain multiple concurrent sessions. Account passwords are not changed by deployment. Broker restart migration keeps the newest existing fixed-participant session.

A Production-only administration page lists the twelve Production-Joker and two Production-Creator accounts. Explicitly confirmed rotation changes only the selected accounts, invalidates their sessions, and signals revocation to receivers. New passwords are shown once and may be downloaded; only salted PBKDF2-SHA256 hashes persist in private session-state/credentials.json. Historical access-credentials.txt is not rewritten by the container and no longer reflects rotated accounts. Test, Staging, Host, Production and Director passwords cannot be rotated by this API.

WebSocket upgrades verify the authenticated session with the private broker; a one-second revalidation closes revoked or expired sessions. A brief broker outage has a 30-second grace period for established connections. Per-account message/byte budgets, backpressure and idempotent seeding reduce flooding. Fixed participants use session cookies rather than legacy Basic authentication.

Updated room/OBS browser pages close revoked peer connections and stop stale automatic reconnects. All browser/OBS pages must be reloaded once after deployment to load this enforcement code. Previously issued third-party TURN credentials retain their provider TTL; they are not revoked by a website password change. The receiver-side teardown applies to this browser deployment.

Tests in deployment/tests use synthetic credentials and isolated loopback servers. No live credentials are included.

## Account navigation, 2026-11-01

An authenticated visit to the bare site root (including /index and /index.html without a query) now opens an account-scoped home. Fixed Host, Creator, Joker and return co-director accounts are redirected to their existing unique personal shortlink. No invitation, password or media settings change. Explicit participant, Director and OBS links continue to use the existing strict entry authorization.

Production receives a selection page with its three authorized main Director entries (without a return publisher), three existing Production-Talk entries and password administration. Director launch URLs are derived on the server from private room/shortlink configuration and validated with the existing entry policy. Only the Production session can resolve them. The three OBS collection accounts receive their own room's fifteen camera sources. Navigation requires a current cookie session; no private links are embedded in source or the unauthenticated login page. The Production toolbar and access administration include a link back to this overview.

Integration tests cover all 52 scoped home routes, source-account restrictions, all Production Director launches and authentication failures, alongside the preceding security tests.
