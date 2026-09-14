# Slang Corpus Pilot

The slang corpus pilot is controlled by `slangPilot.enabled` and defaults to
`false`.

## Disabled contract

When disabled, the application does not:

- create or open `data/slang-pilot.sqlite`;
- inspect messages for slang candidates;
- register background research work;
- change model prompts or tool schemas;
- consume model or search tokens.

The existing manual CRUD interface for `data/slang.json` remains available and
independent of the pilot.

## Discovery

Allowed group messages are inspected after archive deduplication. Discovery is
local and deterministic, using `Intl.Segmenter`, short-expression patterns,
quoted phrases and Latin abbreviations. URLs, commands, QQ numbers, phone
numbers, credentials and blocked senders are excluded.

Candidates are scoped to their source chat. By default, a term must occur three
times across two speakers inside a 72-hour window. Explicit “what does this
mean” patterns can qualify after two observations. Per-chat daily and global
pending limits prevent queue flooding.

Discovery performs no model request. A promoted term enters
`pending_research` and is shown in `Observatory -> Slang Research`.

## Approval workflow

```text
observing
  -> pending_research
     -> research_rejected
     -> research_queued
        -> researching
           -> research_failed / research_interrupted
           -> pending_admission
              -> admission_rejected
              -> admitted_candidate
```

The first approval authorizes model and optional web-search cost. Research runs
in an isolated Session without QQ send tools or asset-write tools. Evidence and
web content are treated as untrusted data. Output must be structured JSON with
meaning, usage, example, variants, scope, risk and confidence.

The second approval may edit the research result and writes it atomically to
`data/slang.json` as `candidate`. It does not become active merely because
research succeeded. The existing asset editor is used to promote reviewed
entries to `confirmed`.

Only `confirmed` entries are included in Agent context. `chat-private` entries
are visible only in their source chat; `global-safe` entries may be used in
other chats. Candidate evidence and source identities are never exposed to the
Agent.

## Administrator commands

The configured administrator can use:

```text
研究黑话 sr_xxx
拒绝研究 sr_xxx
收录黑话 sr_xxx
拒绝收录 sr_xxx
重试黑话 sr_xxx
```

The authenticated console exposes equivalent controls.

## Failure handling

- A service restart changes `researching` to `research_interrupted`.
- Interrupted or failed research requires an explicit retry.
- Research does not run while the source chat is outside its active time.
- Admission is idempotent by normalized term; an existing confirmed entry is
  never downgraded.
- The workflow database is retained when the switch is disabled.

## API

```text
GET  /api/slang-pilot/status
GET  /api/slang-pilot/discoveries?state=&query=&limit=
GET  /api/slang-pilot/discoveries/<id>
POST /api/slang-pilot/discoveries/<id>/research-decision
POST /api/slang-pilot/discoveries/<id>/admission-decision
POST /api/slang-pilot/discoveries/<id>/retry
```
