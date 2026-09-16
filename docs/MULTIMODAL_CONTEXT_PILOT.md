# Multimodal Context Continuity Pilot

This experiment keeps lifecycle conversations cache-friendly when a session needs
an inline image or sticker. It is intentionally narrower than the conversation
lifecycle itself: the visual model still receives the original image during the
current Agent Session, while only the cross-session persistence policy changes.

## Lifecycle State

Configuration is owned by `experimental-multimodal-context.js` and is additive:

```json
{
  "multimodalContextPilot": {
    "enabled": false,
    "graduated": false
  }
}
```

Missing configuration is equivalent to the values above. Enabling the runtime
does not graduate the feature. The experiment page contains only the runtime
switch and concise state, so the pilot has no dedicated product page.

## Disabled Mode: No-Diff Contract

When `enabled !== true`, the installed wrapper delegates the exact original
`commitLifecycleRun(options)` object to `ChatStore`.

It does not change:

- model messages, tool schemas or prompt hashes;
- `multimodal-context` rollover behavior;
- lifecycle deadlines or other rollover reasons;
- checkpoints, message leases, outbox handling or external sends;
- databases, timers or background jobs.

Non-multimodal lifecycle commits bypass the experiment before configuration is
read.

## Enabled Flow

The existing Agent loop is unchanged until the lifecycle commit boundary:

```text
QQ image/sticker
  -> get_message_images / get_sticker_image
  -> inline data:image input is visible to the current model request
  -> Agent finishes normally
  -> orchestrator requests forceRollover=multimodal-context
  -> pilot rewrites only that commit
       - keep the current lifecycle generation
       - do not persist raw image/base64
       - append a compact text-only user/assistant pair
       - retain the structured checkpoint
       - retain source QQ message IDs when available
  -> next Agent Session reuses the existing provider prefix
```

The compact user turn records that the previous batch contained ephemeral visual
input, copies bounded checkpoint fields (`topic`, `summary`, confirmed facts,
decisions, open questions and next step), and includes up to eight source QQ
message IDs. The model is explicitly told that it can call `get_message_images`
again if exact visual detail is needed. The compact assistant turn records the
actual last QQ reply, or the existing no-reply marker.

No `data:image/...` value is written to `thread_turns` by this experiment.

## Token Budget Rule

Provider `prompt_tokens` for the just-finished multimodal request may include a
large image charge that will not exist in the next persisted request. Reusing
that value unchanged would immediately trigger `input-token-budget` rollover and
undo the experiment.

For a rewritten multimodal commit only:

- if the measured prompt tokens are below `lifecycleRolloverInputTokens`, keep
  the measured value;
- otherwise store `threshold - 1` once, allowing the next image-free lifecycle
  request to measure the compacted prefix again.

All non-multimodal requests continue to store the provider's exact token value.
The existing transcript-character limit, hard lifetime and per-run token budget
remain authoritative. If the compacted next request is still too large, its real
usage will re-arm the normal input-token rollover on the following batch.

## Boundaries And Failure Behavior

The pilot deliberately does not override:

- explicit `threadDisposition=close` / `model-close`;
- `context-budget`, `input-token-budget`, prompt-prefix changes or hard lifetime;
- mode changes and commits with `persistThread=false`;
- message lease acknowledgement or durable outbox semantics.

If the checkpoint does not contain enough visual meaning, the next Session may
re-read the referenced QQ image while it is still retrievable. This is preferable
to persisting large image payloads indefinitely, but it remains an experimental
trade-off and should be observed before graduation.

## Pilot Metrics

Compare enabled and disabled lifecycle groups using:

- first-call cached token ratio after image/sticker turns;
- number of `multimodal-context` rollovers per 100 processed batches;
- total input and cached-input tokens per conversation;
- latency of the first model call after a visual turn;
- frequency of repeated `get_message_images` reads;
- checkpoint correctness and duplicate/uncertain send counters.

A healthy result should reduce multimodal-only generation churn without changing
message delivery semantics or increasing unrelated rollover failures.

## Testing

The unit tests cover:

- default-disabled configuration;
- exact-object delegation while disabled;
- no interception of other rollover reasons;
- explicit model-close precedence;
- source QQ message ID preservation;
- absence of inline image data in the persisted canonical transcript;
- token-threshold deferral for the compacted next request;
- idempotent installation of the runtime wrapper.

Run locally with `npm run test:unit` or the full `npm test`. Do not depend on a
GitHub Actions run for this pilot.

## Rollback

Disable **设置 → 实验功能 → 多模态上下文续接**. The next multimodal lifecycle
commit immediately returns to the existing `multimodal-context` rollover path;
no restart or data migration is required. Existing checkpoints and text-only
turns are left intact. Removing the code later only requires removing the server
installer, experiment UI script and these pilot modules/tests.
