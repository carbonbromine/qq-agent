# Unified QQ Identity Pilot

The pilot is controlled by `identityPilot.enabled` and defaults to `false`.
`identityPilot.graduated` is independent from runtime enablement. Graduation
adds the dedicated `旧印象` navigation page; disabling the runtime later keeps
that page and stored data available for inspection. Automatic friend handling
uses `identityPilot.friendProposal.graduated` and owns the separate `好友管理`
page. The experiment settings page contains only enablement and graduation
controls.

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
effect unless the identity pilot master switch is also enabled.

The default `mode=triggered` path is controller-owned:

- a successful automatic message batch creates at most one candidate
  opportunity;
- existing friends never enter the draw or model review;
- friend-list state must be trustworthy; an unavailable refresh fails closed;
- the default relationship gate is 50 messages, 3 active days and 3 reliable
  direct exchanges in the source chat during the last 30 days;
- an eligible candidate receives one configurable draw, defaulting to 5%;
- a hit starts one isolated model request with bounded same-chat history and
  only the `submit_friend_review` result tool;
- ordinary chat sessions contain neither friend-proposal guidance nor
  `friend_request_propose`;
- the service validates evidence IDs, computes the weighted score, rechecks
  friend state and then creates a normal administrator proposal.

The review weights default to interaction quality 40%, concrete continued
interest 30%, reciprocity 20% and stability 10%, with a 70/100 proposal
threshold. A model proposal still cannot approve or send an application.
Draws, misses, reviews, failures and proposal links are persisted in
`friend_opportunities`. They are visible on the dedicated `好友管理` page and
through:

```text
GET /api/identity-pilot/friend-opportunities?status=&limit=100
```

`mode=prompt` remains an explicit rollback mode. Only in that mode:

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

In either mode, the Agent cannot approve its own proposal or tell the candidate
that a friend request was sent. Triggered reviews are queued only after a
successful chat turn and do not block or retry the parent conversation.

### Protocol boundary

OneBot v11 standardizes accepting or rejecting an inbound request through
`set_friend_add_request`; it does not standardize initiating an outbound
request. SnowLuma 1.14.15 has no named outbound friend action, but its
authenticated `send_packet` action can carry the QQ friend-list JCE protocol.
The implementation uses two verified commands:

```text
friendlist.getUserAddFriendSetting
friendlist.addFriend
```

`identityPilot.friendProposal.activeDispatchEnabled` is a third-level,
default-off switch. When it is off, approval keeps the previous
`approved_manual` behavior. When it is on, approval first persists
`dispatching`, queries the target's add-friend setting, and then sends the
request. The Agent-facing proposal tool never calls the protocol directly.

The proposal state machine is:

```text
pending -> approved_manual
pending -> dispatching -> sent -> accepted
                       -> failed
                       -> held_unknown -> accepted
```

Only a decoded QQ business result code of zero produces `sent`. HTTP timeouts,
connection loss, missing responses, and response decode failures after the
write starts produce `held_unknown`; these records cannot be approved or sent
again. A process restart changes an unfinished `dispatching` row to
`held_unknown` before accepting new work. A later OneBot `friend_add` notice,
or a friend-list reindex, is the only automatic path from `sent`,
`held_unknown`, or `approved_manual` to `accepted`.
When private-whitelist synchronization is enabled, the same confirmed friend
event also adds the approved proactive candidate to `allow.private`.

The application never calls `set_friend_add_request` with a made-up flag and
never automatically retries an uncertain external write. Protocol evidence and
compatibility limits are documented in
[SnowLuma outbound friend request research](SNOWLUMA_FRIEND_API_RESEARCH.md).

Authenticated console endpoints:

```text
GET  /api/identity-pilot/friend-proposals?status=&limit=100
POST /api/identity-pilot/friend-proposals/<proposal-id>/decision
     {"decision":"approve"|"reject"}
```

## Incoming friend request approval

`identityPilot.incomingFriendRequest.enabled` is an independent nested switch.
When enabled, OneBot `request_type=friend` events are persisted before the
administrator is notified. Duplicate events with the same OneBot `flag` do not
create a second request or notification.

The configured friend-approval administrator can decide through the console or
an exact private command:

```text
同意好友申请 fr_xxx
拒绝好友申请 fr_xxx
```

Approval and rejection call the standard OneBot `set_friend_add_request`
action. A successful approval adds the requester to `allow.private` and removes
the same QQ number from `deny.private`. When `friend_add` is received, the
request is finalized as `accepted` and whitelist application is retried if
needed.

The incoming request state machine is:

```text
pending -> deciding -> approved -> accepted
                    -> rejected
                    -> failed
                    -> held_unknown -> accepted
```

An HTTP timeout, disconnect, malformed response, or service restart while
`deciding` produces `held_unknown`. Unknown requests cannot be decided again;
the administrator must inspect the QQ client, while a later `friend_add` event
still closes the workflow safely.

Authenticated console endpoints:

```text
GET  /api/identity-pilot/incoming-friend-requests?status=&limit=100
POST /api/identity-pilot/incoming-friend-requests/<request-id>/decision
     {"decision":"approve"|"reject","remark":""}
```
