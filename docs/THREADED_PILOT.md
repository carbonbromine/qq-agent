# Threaded Conversation Pilot

This document describes the earlier two-mode pilot. The lifecycle branch keeps
that mode and adds a third mode documented in
[Conversation Modes](CONVERSATION_MODES.md).

This branch adds a reversible conversation-continuity pilot without replacing
the existing SQLite message lease or outbox delivery model.

## Enable

Open `Settings -> Chat Settings -> Conversation Continuity Pilot` and enable
the persistent conversation thread option. The setting is applied dynamically:

- `legacy`: only the existing mention, keyword and probability policy applies.
- `threaded`: the legacy policy still applies, plus deterministic continuation.

The default remains `legacy`.

## Continuation Rules

After the agent successfully sends a message, the store opens or refreshes one
thread for that QQ chat. During the configured continuation window:

- A new message from a participant in that thread wakes the full model.
- A message that quotes the bot wakes the full model even without a live thread.
- Other group chatter continues to use the configured trigger tier.
- Waking the model never forces a reply.

The chat is still serialized to one active run, so the pilot does not introduce
parallel replies within the same group.

## Persistence

The existing `messages.sqlite` receives two additive tables:

- `conversation_threads`: current materialized thread state, participants,
  engagement deadline, expiry and version.
- `thread_checkpoints`: append-only state snapshots with source message IDs and
  the originating agent run.

The existing `_handoff.json` is dual-written into checkpoints. Disabling the
pilot leaves these tables untouched and immediately restores legacy triggering.

## Prompt And Reasoning

The role card and fixed run guidance now live in the system prompt so the
provider can cache a larger stable prefix. Dynamic time, memory and incoming
messages remain in the user suffix.

Provider `reasoning_content` is returned only to the next API request in the
same tool loop. It is not promoted into long-term memory. Cross-run continuity
uses structured checkpoints containing hypotheses, evidence, confirmed facts,
decisions, rejected directions, unresolved questions and next actions.

## Safety

- Input leases are acknowledged only after the agent run completes.
- Unknown or partial sends still hold the chat for operator review.
- Thread/checkpoint write failures do not cause successful sends to be retried.
- The archive page exposes the current thread and an explicit close action.

## Pilot Metrics

Compare `legacy` and `threaded` by:

- continuation wake recall for the same participant;
- false wakes from unrelated group traffic;
- first-call and later-round cached token ratios;
- prompt tokens and first-token latency;
- duplicate/uncertain sends;
- checkpoint correctness against source message IDs.
