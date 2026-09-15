# QQ Agent Architecture

## Runtime Topology

QQ Agent is a modular Node.js monolith. The OneBot implementation is an
independently managed service; DeepSeek Harness and the legacy Bridge are not in
the message-processing path.

```text
QQ client
  -> external OneBot v11 WebSocket events
  -> per-chat serialized ingestion
  -> SQLite/WAL message state machine
  -> bounded message aggregation and trigger policy
  -> Agent Session and optional conversation lifecycle
  -> OpenAI-compatible model and chat-bound tools
  -> durable outbox
  -> external OneBot v11 HTTP API
```

The same process serves the authenticated management console and SSE updates.
Background managers handle memory consolidation, optional proactive runs, daily
Qzone moments, Qzone interactions and optional identity indexing.

## Module Boundaries

| Area | Main modules | Responsibility |
| --- | --- | --- |
| Bootstrap and HTTP | `server.js`, `app.js` | Dependency assembly, lifecycle, event ingestion, console API and SSE |
| Protocol adapter | `onebot.js` | OneBot WebSocket reconnect, HTTP calls and QQ message normalization |
| Durable state | `store.js` | Message deduplication, leases, outbox, lifecycle transcripts and checkpoints |
| Agent control | `orchestrator.js` | Debounce, trigger policy, concurrency, model/tool loop and recovery |
| Prompt and tools | `prompt.js`, `tools.js` | Persona context and tools restricted to the current chat |
| Delivery | `sender.js` | Per-chat serialization, rate limits, message splitting and outbox completion |
| Model access | `llm.js`, `providers.js` | Chat Completions, retries, provider credentials and usage |
| Memory | `memory.js`, `identity-*.js` | Member impressions, handoff state and optional cross-chat identity index |
| Scheduled social work | `daily-moments.js`, `qzone-interactions.js` | Independently persisted Qzone decisions and external effects |
| Operations | `deploy.sh`, `manage.sh`, `scripts/*.mjs` | Installation, systemd service, health, backup and recovery actions |

`app.js` is the composition root. The protocol, persistence and orchestration
classes are separate, but they run in one process and share the configured data
directory.

## Message State Machine

Incoming messages are deduplicated by `(chat_key, platform_message_id)` and use
these durable states:

```text
pending -> leased -> acked
                 \-> pending  (retryable failure)
                 \-> failed   (permanent or exhausted)
                 \-> held     (an external send may have happened)
```

A unique partial index permits at most one leased run per chat. The Agent only
acknowledges the claimed message IDs after successful processing. Messages that
arrive during a run remain pending for the next batch.

Every outbound effect is inserted into `outbox` before dispatch. A confirmed
response becomes `sent`; a timeout or ambiguous failure becomes `unknown`.
Messages with possible effects are held for operator review instead of being
automatically replayed. This limits duplicate replies but cannot create an
exactly-once guarantee that the external QQ API does not provide.

## Conversation Boundaries

Three identifiers have different ownership:

- `chatKey`: one QQ group or private conversation.
- `sessionId`: one claimed batch and Agent execution, including budgets, tools,
  sends and audit data.
- `threadId`: optional state shared by multiple Sessions in threaded or
  lifecycle mode.

Legacy mode reconstructs bounded context for each triggered batch. Threaded mode
adds deterministic continuation behavior. Lifecycle mode stores an append-only
provider transcript in SQLite while the lifecycle is active, so later Sessions
continue the same model context without keeping an HTTP request open while idle.
Structured checkpoints survive lifecycle rollover.

## Persistence

The deployment data directory contains:

- `config.json`: runtime configuration and credentials, mode `0600`.
- `messages.sqlite`: messages, leases, outbox, threads and checkpoints.
- `sessions/`: per-run audit records.
- `memory/`: member impressions and handoff state.
- Optional feature-specific SQLite databases, such as the identity index.
- Qzone task state and managed sticker metadata.

SQLite uses WAL and `synchronous=FULL`. JSON stores use temporary-file rename
where their modules require atomic replacement. These stores and remote API
effects do not form one global transaction, so each background manager owns its
own idempotency and recovery rules.

## Security Boundaries

- Empty allowlists do not allow traffic unless `allowAllWhenEmpty` is explicit.
- Observe mode archives input but blocks normal model runs and all delivery.
- Tool closures bind sends and reads to the current chat.
- Console credentials are omitted from normal config responses.
- LAN console binding requires a token; plain HTTP still requires a trusted
  network or a TLS reverse proxy.
- Remote image and page retrieval validates schemes, DNS answers, redirects and
  response sizes to reduce SSRF and resource-exhaustion risk.
- Credentials, login state and runtime data are excluded from Git.

## Linux Deployment

`deploy.sh` is the supported installation and update entry point:

1. Validate Linux, paths, tools, source files and service access.
2. Reuse Node.js 22.13+ with `node:sqlite`, or download a pinned Node archive and
   verify it against the official SHA-256 manifest.
3. Lock the data directory and snapshot the previous application/config/unit.
4. Stop the existing service, synchronize source and run reproducible production
   dependency installation.
5. Create or update configuration without resetting an existing runtime mode.
6. Install and verify a hardened user-level systemd unit.
7. Install the independent GitHub update service/timer, enable linger, start the
   Agent and require `/healthz` to succeed.
8. Restore the prior code, configuration, unit and active state on failure.

The installer records the exact deployed Node executable. `manage.sh` uses that
runtime, so status, backup and recovery commands still work when the host has no
system Node.js installation.

The update timer never modifies the live tree directly. Its oneshot worker
shallow-fetches GitHub into the data directory, tests a temporary checkout and
then invokes the same `deploy.sh` transaction. Failed updates disable future
automatic attempts and are reported through the running or restored Agent.
