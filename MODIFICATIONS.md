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

## Room-specific account-list downloads, 2026-11-01

Production can download a complete UTF-8 text access list separately for Test, Staging and Production from the access-management page. Each list includes only the chosen room's accounts, its return co-director, its OBS source links and the shared Production account's appropriate main Director/Talk entries. No accounts, invitations, sessions, passwords or media settings are changed by exporting.

Downloads require the current Production cookie session, a same-origin POST and a dedicated action header; other users and anonymous requests cannot export any list. Responses are attachment-only, no-store and no-referrer. Original password values come from an optional private runtime export source, prepared from the existing protected access list only after verifying the base password hashes. Each exported password must still match the account's current credential fingerprint. Rotated hash-only passwords are clearly marked as not recoverable and obsolete original values are never returned. Future rotations continue to store only salted password hashes and display the new values once.

The private export file is not part of the corresponding source; a preparation script is provided. The existing read-only broker secrets mount is reused. No Nginx, Compose, port or network change is needed. Tests verify complete room membership and OBS source scope, access/CSRF/method restrictions and suppression of obsolete passwords after rotation.

## Recoverable encrypted password exports, 2026-11-01

Newly reset Production Joker/Creator passwords are now saved as authenticated AES-256-GCM ciphertext alongside their PBKDF2-SHA256 login records in the same atomic credentials.json replacement. A fresh 96-bit nonce is generated for every encryption. Associated data binds ciphertext to the username, salt and password hash, preventing substitution across users or credential versions. The separate private 256-bit export key is mounted read-only from secrets/password-export.key; it is never included in public source or logs. Login authentication continues to use the password hash.

Production's existing protected room-list download decrypts the current export value; subsequent downloads and broker restarts retain it. Export responses still require a current Production session and same-origin action POST. Rotations fail without changing accounts if the encryption key is absent. Wrong keys or modified ciphertext fail closed. Old hash-only reset records remain valid for login but cannot be recovered mathematically. They require one explicit reset to populate an export value. No reset is performed automatically on startup or normal deployment; migration requires an explicit reset of the affected legacy Production Joker/Creator accounts. Host/Production/Director/Test/Staging credentials remain outside the reset API.

Tests cover encrypted export after reset/restart, absence of plaintext in persistent state, missing/wrong keys, tampering and account substitution, legacy-record compatibility and failed atomic writes preserving credentials, plus the preceding room access and signaling checks.

## Participant tools and Markdown exports, 2026-11-01

Room access-list exports are now Markdown attachments. A shared login address replaces redundant participant and long Director invitation URLs; the fifteen tokenized OBS source links remain because Browser Sources need them. All eighteen room accounts and current encrypted/original passwords remain included. Markdown code spans and text escapes preserve values without allowing names to create document markup.

Production has room-selectable participant management for all fifteen Host/Creator/Joker accounts per environment. Each row offers a credential-copy action and a display-name input. Credential copying requires a current Production session and dedicated same-origin POST; it retrieves only the chosen participant's current password and composes an email-ready text, without sending email. GET lists contain no password. Existing Production-Joker/Creator-only password-reset permissions remain unchanged; the Host has no reset checkbox. Protected Production/Director/OBS accounts cannot be copied or renamed through these endpoints.

Display names persist separately in private session-state/display-names.json and never mutate account usernames, login hashes, access policies, streams or invitation maps. Names are validated and normalized, limited to sixty Unicode name characters, and can be cleared. Authenticated participants receive only their own effective label, username followed by a colon and the optional display name. The browser loads this label before publishing and polls for changes, using VDO.Ninja's native changeLabel message. Audio/video routing and signaling server implementation are unchanged. Reload existing participant pages once to load the new helper; subsequent central name edits propagate without reissuing links.

Tests cover participant-copy roles and CSRF protection, all three room scopes, reset-account restrictions, profile validation/persistence and no credential or policy mutation, Markdown output without redundant direct links, current encrypted-password copying, and initial/live label updates with service-outage preservation.
