# Conversation Modes

The conversation engine has three runtime-selectable modes. The global default
can be overridden for each allow-listed group; private chats use the global mode.
Changing a mode does not require a restart.

## Modes

### Legacy

Only the configured mention, keyword and probability policy can start a model
run. This preserves the original behavior and is the rollback mode.

### Threaded

After the agent sends a message, the intended participant receives a short
continuation window. A reply to the bot also triggers deterministically. Other
messages continue to use the legacy trigger policy.

### Lifecycle

An initial legacy trigger opens a locally persisted conversation lifecycle.
While it is `active` or `listening`, every incoming batch in that chat reaches
DeepSeek, which can reply or remain silent.

The default lifecycle deadlines are:

- `listening`: close after 5 minutes without another processed batch.
- `active`: close after 20 minutes without another processed batch.
- hard lifetime: 30 minutes from the original opening time and never extended.
- `rollover_armed`: after an active hard-limit closure, the next arbitrary
  message may resume from the checkpoint for up to 10 minutes.

These are application deadlines. No HTTP request or model process is kept open
while waiting.

## DeepSeek Context

Lifecycle mode stores an append-only provider transcript in SQLite. Each new
model request uses:

```text
stable system prompt + prior provider transcript + current message batch
```

This preserves an exact prefix for DeepSeek context caching. Provider
`reasoning_content` is retained only inside the active lifecycle so tool calls
can continue correctly. Raw lifecycle transcript is deleted when the lifecycle
closes or rolls over; the structured checkpoint remains.

The transcript is also rolled over when:

- the system prompt or tool schema changes;
- a turn contains inline image data;
- the configured transcript character budget is exceeded.

## Persistence And Recovery

`messages.sqlite` contains:

- `conversation_threads`: current state and deadlines;
- `thread_turns`: active lifecycle provider messages;
- `thread_checkpoints`: append-only structured state with source message IDs.

The recovery loop evaluates persisted deadlines every five seconds, so process
restarts do not reset active, listening or rollover states.

The active provider transcript is temporary working state. Closing or rolling a
lifecycle deletes it from `thread_turns`; the normal per-run audit files retain
their existing provider response records according to session retention policy.

## Runtime Identity And Boundaries

The runtime uses three different identifiers and persistence scopes:

- `chatKey` identifies the QQ conversation, such as `group:1108998242`.
- `sessionId` identifies one Agent execution for one claimed message batch.
  It owns the timeout, tool rounds, usage, send audit and success/failure result.
- `threadId` identifies the lifecycle shared by multiple Agent Sessions. It owns
  lifecycle deadlines, the append-only provider transcript and checkpoints.

One lifecycle therefore normally contains multiple Session records:

```text
QQ messages
  -> debounced message batch
  -> one Agent Session
  -> read prior thread_turns by threadId
  -> call model and tools
  -> atomically acknowledge batch + append transcript + checkpoint
  -> end Agent Session
  -> keep lifecycle thread active/listening for the next batch
```

The Session boundary is intentional. It provides an isolated message lease and
retry boundary without keeping an HTTP request or model process alive during the
idle part of a lifecycle. It does not reset model context.

The console keeps those execution boundaries but groups `threaded` and
`lifecycle` Sessions by `threadId`. One thread appears as one list item with an
internal batch timeline. Selecting a batch shows that run's exact audit data.
Legacy Sessions remain one item per run because they do not share a thread.

## Context Inspector

Each new Session audit records:

- the provider transcript injected from the existing lifecycle;
- the latest complete model request (`messages`, tool schemas and request options);
- exact provider token usage for every tool round, including cached input tokens;
- provider `reasoning_content` when the selected model returns it.

The request snapshot omits inline image bytes to avoid duplicating large base64
payloads in every Session file. The message structure, MIME type and original
request character count remain visible. Token values come from provider usage
instead of being estimated from character counts.

## Operational Guidance

Start with lifecycle mode on one active group. Compare it with threaded and
legacy groups using first-call cache rate, continuation wake rate, silent model
runs, response latency and duplicate-send counters. The existing message lease
and held-delivery rules remain authoritative in all three modes.
