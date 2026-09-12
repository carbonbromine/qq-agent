# Unified QQ Identity Pilot

The pilot is controlled by `identityPilot.enabled` and defaults to `false`.

## Disabled contract

When disabled, the application does not:

- instantiate `IdentityPilotManager`;
- create or open `identity-pilot.sqlite`;
- scan message archives or legacy memory files;
- call OneBot for the friend list;
- add tools, prompt text, model requests or timers.

The regression test compares the complete provider request produced by a legacy
configuration with one that explicitly sets `enabled=false`.

## Enabled behavior

Enabling the switch creates `data/identity-pilot.sqlite` and performs a local,
non-model backfill:

- numeric QQ IDs are the only cross-chat identity key;
- allowed group and private archives contribute aliases and activity counts;
- currently blocked group members and disallowed chats are excluded;
- `get_friend_list` marks existing friends and supplies the preferred display name;
- existing `data/memory` impressions are indexed without modifying source files;
- new incoming messages update the index synchronously after archive deduplication.

The database is separate from `messages.sqlite` and the existing `memory/`
layout. Disabling closes its handle and stops incremental updates; indexed data
is retained for a later re-enable.

## Person lookup tool

While the pilot is enabled and its database is active, Agent sessions receive
`person_memory_lookup`. The tool:

- requires a numeric QQ ID;
- only accepts the current private peer or a member indexed in the current group;
- returns unified aliases, friend status and aggregate activity counts;
- returns legacy memory text only from the current chat;
- reports only a count for memories from other contexts, never their source
  chat, raw text or message IDs.

Disabling the pilot removes both the tool schema and its system-prompt guidance.
This phase does not automatically inject unified identity data, generate new
profiles, or create friend proposals.
