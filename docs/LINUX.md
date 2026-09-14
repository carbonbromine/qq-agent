# Linux Deployment And Operations

## Isolation

This fork runs independently of qq-bridge/DSH. It never edits, stops, upgrades,
or imports the old service's session databases. An optional first-install import
copies the OneBot endpoints, allow/deny lists and model selection into a NEW config.
Passing `--credential-file` explicitly copies its DeepSeek API key. Both configs
remain independent. Credentials, login state and runtime data must not be committed.

The existing OneBot server may be shared in observe mode. Do not log the same QQ
account into a second protocol server. To activate both agents concurrently, use
different QQ accounts or disjoint allowlists. The control panel requires explicit
exclusive-use confirmation; it does not automatically stop the old instance.

## Requirements

- Linux with systemd user services, curl, tar, sha256sum and rsync.
- A mounted local filesystem for SQLite (not NFS/SMB).
- A separately managed OneBot v11 HTTP/forward WebSocket service when using
  `deploy.sh`; `deploy-all.sh` installs SnowLuma/OneBot.
- An OpenAI Chat Completions compatible model with function calling.
- For boot without interactive login: `loginctl enable-linger USER`.
- A fixed free port; LAN binding requires a console token.

## Full-stack Installation

Use `deploy-all.sh` on a new host when SnowLuma/OneBot is not installed yet:

```bash
bash deploy-all.sh
```

The installer asks for the stack root and all five host ports. It does not ask
for a local/LAN IP. The Agent console, SnowLuma WebUI and noVNC bind all host
interfaces; OneBot HTTP and WebSocket bind only `127.0.0.1`. If Docker is
missing, the installer asks before installing Docker Engine and Compose through
the host package manager.
It does not modify UFW, firewalld or cloud security-group policy. Allow only the
three selected user-facing ports from trusted LAN/VPN ranges when host firewall
rules are enabled; never expose noVNC or OneBot directly to the public Internet.

The resulting layout is:

```text
STACK_ROOT/
  app/                    deployed QQ Agent code
  data/                   QQ Agent persistent data
  snowluma/
    docker-compose.yml
    .env                   generated service credentials
    data/                  SnowLuma and OneBot configuration
    client-config/         QQ client configuration
    client-data/           QQ login state and cache
  deployment-access.txt   generated URLs and credentials (0600)
```

The SnowLuma image is pinned to the tested `v1.14.15` release by default.
Download or container startup failures stop the installation with an error.
One shared OneBot token is written to SnowLuma's global template, every existing
per-account config and QQ Agent's configuration. Existing installations retain
their credentials unless `--rotate-credentials` is selected.

On a fresh interactive install, the script also asks for the model endpoint,
API key, model name and QQ allowlists. After the infrastructure checks pass,
open the printed noVNC URL and scan the QQ login QR code, then return to the
terminal. The installer verifies `get_login_info` and offers to activate the
Agent. QQ login is intentionally the only unavoidable manual protocol step.
Until activation, the Agent stays in `observe`.

Non-interactive `--yes` installation requires `--model-base-url`,
`--model-api-key` and `--model`. Use `--skip-model-config` only when the model
will deliberately be configured later in the management console. An empty
allowlist remains deny-by-default.

Use `deploy.sh` directly when a compatible OneBot service already exists or
when only the QQ Agent process should be installed or updated:

```bash
bash deploy.sh \
  --install-dir /mnt/data/qq-agent/app \
  --data-dir /mnt/data/qq-agent/data \
  --host 192.168.31.109 --port 3210 \
  --service qq-agent-linux
```

Create the parent directory with appropriate ownership first. Run deployment as
the service user, not root. The installer uses sudo only for linger if required.
Dependencies are installed with `--omit=dev --ignore-scripts`: Linux needs no
Electron, GUI, X11, browser, compiler or native SQLite add-on.
If no compatible Node.js is found, the script downloads Node.js 22 into
`INSTALL_DIR/.runtime` and verifies it against the official SHA-256 manifest.
`--node /absolute/path/to/node` remains available to use an existing runtime.
Run `bash deploy.sh --help` for the complete option list.

For an existing installation, deployment creates a code snapshot under
`DATA_DIR/deploy-backups/` before stopping the service. Source synchronization
uses deletion-aware `rsync`, while preserving the data directory, local runtime,
deployment metadata and credentials. If dependency installation, configuration,
systemd validation or health checking fails, the installer restores the previous
code, configuration and service unit before restarting the old service. Use
`--no-backup` only when an external rollback mechanism is already in place.

Optional import on FIRST install only:

```bash
bash deploy.sh --install-dir /mnt/data/qq-agent/app \
  --data-dir /mnt/data/qq-agent/data --host 192.168.31.109 --port 3210 \
  --import-bridge /home/sourcecode/apps/qq-bridge/config.json \
  --credential-file /home/sourcecode/.config/dsh/credentials.env
```

The first installation enters observe mode and does not activate replies
automatically. Updating an existing installation preserves its current mode.
Model/API settings for non-DeepSeek providers must be configured in the new console.
The repository contains no Electron shell, Windows installer, bundled protocol
launcher, community upload client, telemetry client, or online updater. Manage the
external OneBot implementation as its own Linux service.

## Control Panel

Open `http://HOST:PORT`, obtain the token with `bash manage.sh token`, and log in.
The cookie is HttpOnly and SameSite=Strict; credentials are not returned by
`/api/config`. On an untrusted network, terminate TLS in front of the service.
Plain HTTP on the LAN is not encrypted. `/healthz` exposes only a liveness boolean.
API endpoints accept `x-console-token`; do not put the token in URLs.

The top selector changes observe/active mode. Observe stores messages but makes
no automatic model calls and blocks text, stickers, pokes and test sends.
Explicit administrator actions such as model testing or memory consolidation
may still use the API. Activation skips the observe backlog by default.

The console Token can be rotated under **Settings → Desktop → Console Security**.
Enter the current Token and the new Token twice. A successful rotation updates
the HttpOnly cookie and `data/console-access.txt` atomically from the user's
perspective; the old Token and other browser sessions stop authenticating
immediately. The general “Save Settings” action cannot change the Token.

```bash
bash manage.sh status
bash manage.sh logs
bash manage.sh health
bash manage.sh observe
bash manage.sh activate --confirm-exclusive
# Process old backlog only when deliberately requested:
bash manage.sh activate --confirm-exclusive --with-backlog
bash manage.sh stop
bash manage.sh start
bash manage.sh restart
```

`activate` does NOT stop qq-bridge. Stop/exclude the old instance's chats first.
Rollback is simply `manage.sh observe` or `stop`; the old installation is untouched.
Do not run multiple processes against one data directory.

## Message Lifecycle

```text
OneBot -> serialized per-chat ingestion -> deduplicated SQLite message
        -> bounded debounce -> trigger policy -> claim batch lease
        -> fresh system/user prompt -> model/tools -> ack only claimed IDs
                                            -> failure: retry / failed / held
```

- `pending`: awaiting processing, never removed by history retention.
- `leased`: a bounded snapshot belongs to one run, still unacknowledged.
- `acked`: successfully processed or deliberately skipped by trigger policy.
- `failed`: invalid configuration, budget exhaustion, or three failed batch attempts.
- `held`: sending succeeded partially or may have succeeded before failure.

On restart, leases remain durable. Recovery runs every five seconds. Expired
leases with no send effects become pending; leases with possible send effects are
held. The default lease lasts four minutes, giving a three-minute run time limit
one minute to unwind. Do not forcibly steal unexpired leases.

OneBot has no exactly-once/idempotency contract. A lost HTTP response cannot prove
whether QQ received a message. Outgoing intent is persisted before sending;
unknown delivery stops that batch and holds the chat for operator review.
It is never automatically replayed. This avoids pretending that retries guarantee
exactly-once sending.

```bash
bash manage.sh retry-failed group:123 --confirm
# AFTER inspecting QQ and the session log; this ACKs, it does not resend:
bash manage.sh resolve-held group:123 --confirm
```

The same actions are available on the archive page. Inspect failure counters there.
No forced reply policy is added: at full trigger tier every batch reaches the
model, but the model can finish without sending. Lower tiers intentionally skip
unmatched messages before calling the model.

## Daily Qzone Moments

The optional daily-moments scheduler runs on an `Asia/Shanghai` wall-clock time.
It builds an internal summary from each eligible group's messages, member memory
and handoff state. The model may use a restricted search/fetch tool loop, inspect
recent group images or saved stickers, and then explicitly choose `publish` or
`skip`. Qzone writes use SnowLuma's `send_qzone_msg` action; text and image
publishing requires SnowLuma `1.14.15-node` or newer.

Each run is persisted in `daily-moments.json` before any external write. A
`publishing`, `published` or `publish-unknown` record blocks automatic reruns for
that Shanghai calendar day. Recent Qzone content is also checked before publish
to avoid duplicating an already-created post after an ambiguous response.
On startup, interrupted `running` generation records become `interrupted`;
`publishing` records become `publish-unknown` and remain protected. Manual draft
generation may retry pre-publish failures, but never overrides an uncertain send.
Invalid submission JSON is returned to the model for correction; an exhausted
correction budget is a failure, not an implicit skip.

The console can publish an existing preview by record ID without another model
call, or reconcile an uncertain send using the Qzone list. Publishing requires
the current persona fingerprint, source-chat permissions, runtime and active-hours
checks to pass. Details and the persona-oriented prompt design are documented in
[DAILY_MOMENTS.md](DAILY_MOMENTS.md).

## Qzone Interactions

The optional interaction scheduler polls SnowLuma for friend feeds every 60
minutes and checks comment conversations every 5 minutes by default. Both
intervals are configurable. SnowLuma does not currently emit Qzone feed/comment
events, so new activity is detected on the next poll.

Unread feeds are persisted, sorted newest first and submitted to the model as one
batch. The usable input budget is the lower of the configured model context
window and Agent run budget, minus output headroom. Older items omitted by that
budget remain unread for a later cycle.

Likes and top-level comments use SnowLuma `like_qzone` and `comment_qzone`.
Nested replies use the current OneBot Qzone cookie with native
`commentId/commentUin` relation fields. Cookies are never persisted. Every write
is persisted before dispatch; a timeout or restart becomes `unknown` and is not
retried automatically. Details are in
[QZONE_INTERACTIONS.md](QZONE_INTERACTIONS.md).

## Budgets And Context

- `wakeDelayMinMs=8000`, `wakeDelayMaxMs=12000`,
  `drainDelayMs=10000`, `maxBatchWaitMs=20000`.
- Each automatically scheduled batch draws a new debounce delay from the
  configured range. The max-batch timer still caps continuous aggregation at
  20 seconds from the first pending message.
- `store.batchLimit=100`, `store.batchMaxChars=32000`.
- History <=300 messages and <=24000 characters; each message excerpt <=2000 characters.
- Full messages remain on disk and can be inspected via detail/history tools.
- Member memory is limited to related members and <=6000 prompt characters.
- Per-chat handoff state stores confirmed facts, decisions, open questions, the
  next step and last actual reply. It expires after 24 hours by default, is
  capped at 4000 prompt characters, and can be edited or cleared in Memory.
- API request timeout defaults to 60 seconds including the response body.
- Run deadline defaults to 180 seconds, at most 12 rounds and 160000 cumulative tokens.
- Before each additional tool round, the next input is estimated from the preceding
  provider usage with output headroom. A run that would exceed the budget ends safely
  and commits confirmed effects instead of turning them into a held retry.
- Lifecycle generations roll over before the next batch when the preceding request
  reached 32000 input tokens. The character limit remains a secondary fallback.
- Usage of failed attempts is retained; unknown delivery results still require review.
- LLM transient requests retry twice with backoff; persisted batch attempts cap at three.
- Dashboard and usage-page costs are calculated from each provider call's model,
  timestamp, prompt tokens, cached prompt tokens and completion tokens. Calendar-day
  ranges use `Asia/Shanghai` regardless of the Linux host timezone.

Legacy and threaded Agent Sessions use bounded reconstructed context plus the
structured handoff. Lifecycle mode additionally carries the active thread's
provider transcript, including tool traces and provider-returned
`reasoning_content`, into later runs with the same `threadId`. The console exposes
the injected transcript, latest complete model request and per-round provider
Token/cache counters. Total cost still depends on batch size, outputs, images,
tool use and provider caching. This is bounded context, not a constant-price
guarantee. General DSH Skills/workspace/approval capabilities are intentionally
not included. Old owner friend-approval commands continue to belong to the old
Bridge.

## Active Hours

`timeControl.enabled` defaults to false and bypasses all time rules, including
per-conversation overrides. When enabled, `schedule.mode` is
`deepseek-offpeak`, `custom`, or `always`. The default uses Shanghai weekday
off-peak windows 00:00-09:00, 12:00-14:00, 18:00-24:00 and full weekends.
`overrides["group:<id>"]` and `overrides["private:<id>"]` replace the default;
removing an override restores inheritance. Custom `windows` contain `days`
(1=Monday through 7=Sunday), `start` and `end` (HH:mm; end supports 24:00).
An end earlier than start crosses into the following day. Empty custom windows
mean no active hours.

Inactive inputs are recorded as acknowledged history, not queued for catch-up.
Normal conversations retain their legacy/threaded/lifecycle policy during active
hours. Model requests and retries, memory consolidation, token-producing search,
vision/model probes and sends are gated before dispatch. In-flight requests are
aborted at the closing boundary or a configuration change; upstream processing
already accepted by a provider can still incur charges. Unknown deliveries retain
their held state. Daily moments use the global schedule and exclude currently
inactive source conversations, deferring scheduled work while globally inactive.

The master switch is not automatically enabled by deployment. Configure it in
Settings -> Time Control. Status is available at `/api/time-control/status`.

## Data And Backup

The data directory contains `config.json` (0600), `messages.sqlite` plus WAL/SHM,
member memory files, per-chat `memory/*/_handoff.json`, `daily-moments.json`,
`sessions/` and sticker metadata. systemd uses UMask=0077.
Legacy `messages/group_123.json` files migrate once transactionally and are left
unchanged. Corrupt archives abort migration rather than being treated as empty.
Keep messages on a disk with sufficient free space; completed session logs default
to a retention count of 2000.

```bash
bash manage.sh observe
bash manage.sh backup /mnt/data/backups/qq-agent-20260911
```

Observe/cancel and wait for runs to finish for a consistent multi-file snapshot.
SQLite backup uses the online backup API, not a raw copy of the database that
could omit WAL data. Backups contain credentials and private messages.

For restore: stop this service, archive its current data directory, restore the
backup into an empty data directory owned by the service user, then start in
observe mode. Do not overwrite the old qq-bridge data.

## Validation

```bash
npm ci --omit=dev --ignore-scripts
npm test
npm run test:unit
node --check src/server.js
bash -n deploy.sh manage.sh
```

Tests use local mock protocol/model servers and isolated temporary data. Real QQ
end-to-end reply validation requires an exclusive test chat/account and explicit
activation. Observe-mode deployment validates receipt without emitting replies.
