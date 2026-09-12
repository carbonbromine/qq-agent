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
This phase does not automatically inject unified identity data or generate new
profiles.

## Proactive friend proposals

`identityPilot.friendProposal.enabled` is a second, nested switch. It has no
effect unless the identity pilot master switch is also enabled. When enabled:

- Agent sessions receive `friend_request_propose`;
- the target must be a numeric QQ ID already seen in the current chat;
- existing friends, the approval administrator, low-activity identities,
  duplicate open proposals and identities still in cooldown are rejected;
- the Agent must choose `interest`, `frequent` or `banter` and provide a concrete
  reason based on actual interaction;
- proposals are stored in `friend_proposals` inside `identity-pilot.sqlite`;
- the configured administrator receives a private approval message;
- approval is accepted only through the authenticated console or an exact
  administrator private command:
  `同意好友 <proposal-id>` / `拒绝好友 <proposal-id>`.

The Agent can only propose. It cannot approve its own proposal or tell the
candidate that a friend request was sent. No background model scheduler is
created: the tool is only available inside an already-running conversation, so
idle checks consume no additional model tokens.

### Protocol boundary

OneBot v11 standardizes accepting or rejecting an inbound request through
`set_friend_add_request`; it does not standardize initiating an outbound friend
request. The deployed SnowLuma 1.14.15 runtime likewise has no outbound action.

For that reason, an approved proposal enters `approved_manual` instead of being
reported as sent. The console shows that manual QQ action is required. A later
OneBot `friend_add` notice, or a friend-list reindex, changes the proposal to
`accepted`. The application never calls `set_friend_add_request` with a made-up
flag and never retries an unknown external write.

Authenticated console endpoints:

```text
GET  /api/identity-pilot/friend-proposals?status=&limit=100
POST /api/identity-pilot/friend-proposals/<proposal-id>/decision
     {"decision":"approve"|"reject"}
```
