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

## Current boundary

This phase does not inject unified identity data into model prompts, register a
person-memory tool, generate profiles, or create friend proposals. Those
behaviors must remain behind the same master switch in later phases.
