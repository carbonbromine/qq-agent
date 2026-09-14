# SnowLuma Outbound Friend Request Research

## Scope

SnowLuma 1.14.15 implements `set_friend_add_request`, which handles an inbound
request. It does not expose a named OneBot action for initiating a new friend
request. QQ Agent therefore uses SnowLuma's authenticated `send_packet` action
behind a default-off experiment rather than inventing a fake request flag.

## Verified Protocol

The deployed Linux QQ client accepted and answered these service commands
through SnowLuma's existing Hook transport:

```text
friendlist.getUserAddFriendSetting
friendlist.addFriend
```

The request and response payloads use JCE/TARS wrappers with servant
`mqq.IMService.FriendListServiceServantObj`. A read-only setting query returned
a valid 125-byte response. A self-targeted add request returned a valid
148-byte response with business code `1` and the QQ wording
`添加失败，请稍后再试`. The negative result is important: SnowLuma's generic
`send_packet` reports transport success as OneBot `retcode=0`, so callers must
decode the inner friend-service business code.

The request shape was cross-checked against:

- QQNT's `NodeIKernelBuddyService.reqToAddFriends`;
- the `ReqToFriend` native structure;
- the established `icqq` JCE implementation.

## Safety Contract

- The protocol adapter is unreachable unless all three switches are enabled:
  `identityPilot.enabled`, `friendProposal.enabled`, and
  `friendProposal.activeDispatchEnabled`.
- The Agent may only create a proposal. An authenticated administrator must
  approve it before any write starts.
- The database changes `pending` to `dispatching` before calling SnowLuma.
- Only an inner QQ business code of zero changes the state to `sent`.
- `sent` means the request was accepted for delivery, not that the target is a
  friend.
- Transport loss or an unparseable response after dispatch changes the state to
  `held_unknown`; no automatic retry is allowed.
- Startup recovery changes stale `dispatching` rows to `held_unknown`.
- A `friend_add` notice or friend-list reindex closes the workflow as
  `accepted`.

## Compatibility Limits

The first implementation supports QQ add-friend settings `0`, `1`, and `4`,
matching the established protocol behavior. Question/answer or security
challenge modes fail before the write request. SnowLuma upgrades may change the
legacy service contract, so this remains an explicitly opt-in experiment.
