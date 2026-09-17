# Relationship State V2

Relationship V2 replaces the removed `relationshipPilot` V1 experiment. V1's
`relationship-pilot.sqlite` is left untouched as a historical artifact, but no
runtime code, configuration or UI reads it and no V1 score is migrated.

## Lifecycle and ownership

The feature is controlled by `relationshipV2.enabled` and defaults to disabled.
`relationshipV2.graduated` only controls the dedicated `关系` navigation entry.
Disabling the runtime stops observation, background evaluations and prompt
adaptation while preserving `relationship-v2.sqlite` for inspection.

`src/relationship-v2.js` owns the runtime and background queue. Its supporting
config, prompt and store modules are all prefixed `relationship-v2-`. It consumes
message evidence through `ChatStore.relationshipEvidence()` rather than reading
the message database directly and has no dependency on Identity Pilot.

## State model

V2 intentionally has no combined affinity score.

- `familiarity`: recency-weighted direct interaction exposure; it decays.
- `bondLevel`: durable relationship level from `-2` to `3`.
- `bondProgress`: progress toward the next durable level.
- `recentWarmth`: short-lived positive tendency, default half-life 12 hours.
- `recentTension`: short-lived negative tendency, default half-life 48 hours.
- `boundaryState`: unresolved boundary state; it does not disappear through time.
- `bondConfidence`: read-time confidence after prolonged inactivity.

Recent channels use bounded multiplicative updates. They are never added to the
durable level. Policy resolution applies boundary and tension first, then the
durable band; recent warmth may alter expression by at most one step.

Ordinary pleasant exchanges can only affect recent warmth. A positive durable
promotion requires multiple unconsumed eligible events across multiple Shanghai
calendar days and at least two event types. Thresholds become progressively
harder at higher levels. A repair reduces tension and may clear an open boundary,
but cannot itself create positive durable progress.

A conflict raises short-term tension and invalidates uncommitted positive bond
progress. Only a high-strength, high-confidence conflict directly lowers the
durable level. A boundary crossing has stronger priority and can lower the level
at a lower threshold. This asymmetry makes trust slow to acquire without making
one ordinary disagreement permanently destructive.

## Evaluation

Automatic evaluation is only considered for private messages, mentions or
replies to the Agent. The default gate is six direct messages and a twelve-hour
per-person cooldown. Jobs are persisted before the model call, processed in a
single background queue and expose exactly one structured result tool with
`tool_choice=auto` for Thinking-model compatibility. The parser still requires
that one tool call and rejects free text. A failed job becomes
`failed_reviewable`; it is not automatically retried in a loop.

The evaluator receives the current versioned role card and must attach persona
basis identifiers to events. Only target-user messages explicitly marked as
countable may be cited. Agent and third-party messages are context only.

Authenticated manual evaluation:

```text
POST /api/relationship-v2/evaluations
{"userId":"12345","fromTs":0,"toTs":0}
```

The request returns HTTP 202 with a durable job. The dedicated relationship page
shows runtime state, relationship states, job history and advanced settings.

## Behavior adaptation

`behaviorInjectionEnabled` defaults to false independently of the experiment
runtime. When enabled, the main Agent receives deterministic text guidance, not
raw event text or scores. Guidance may adjust social distance, banter permission
and de-escalation, but must not change personality, factual standards, task
quality, permissions or safety boundaries.

## Rollback

Turn off `relationshipV2.enabled`. This stops new observations, evaluations and
behavior guidance without deleting the V2 database. The page remains available
after graduation for inspection. Re-enabling recovers queued jobs; a job that
was running during process termination is safely returned to the queue.

## Research and rollout plan

1. **Offline calibration.** Build a redacted, stratified replay set containing
   ordinary chat, repeated friendly chat, reliable follow-through, disagreement,
   harassment, boundary repair and long inactivity. Two human reviewers label
   event type, evidence span and whether an event is durable. Tune prompts and
   thresholds against event precision first; false durable positives are the
   primary failure metric.
2. **Shadow deployment.** Enable V2 with `behaviorInjectionEnabled=false` for at
   least two weeks. Audit a random sample plus every durable promotion, durable
   demotion, boundary event and failed job. Compare state transitions with human
   review, evaluation volume, token cost and per-user trigger frequency.
3. **Counterfactual review.** For sampled conversations, render the deterministic
   policy guidance without sending it. Review whether it would preserve the role
   card, factual quality and safety behavior. Any personality rewrite, excessive
   intimacy or degraded help quality is a release blocker.
4. **Limited behavior trial.** Enable behavior injection for a small allowlisted
   cohort while keeping the evaluator and policy versions fixed. Compare reply
   pairs for tone distance, conflict escalation, boundary compliance and user
   complaints. Do not optimize for message count or user dependence.
5. **Graduation gate.** Graduate only after the durable-event precision target,
   reviewer agreement, cost ceiling and zero personality-drift blocker all hold
   for two consecutive review windows. Version prompt, reducer and policy changes
   independently and restart shadow validation after a material change.

Rollback triggers include unexplained mass promotions, evaluation storms,
cross-user evidence leakage, personality drift, increased conflict escalation or
material latency in the main chat path. Rollback is the lifecycle switch; the
database remains available for post-incident review.
