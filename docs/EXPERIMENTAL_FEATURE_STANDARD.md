# Experimental Feature Development Standard

This document is mandatory for every feature introduced behind an experimental
flag.

## 1. Feature Lifecycle

An experimental feature has two independent states:

- `enabled`: whether its runtime behavior is currently active.
- `graduated`: whether the feature has been accepted as a durable product
  capability with a first-class navigation entry.

Enabling a feature must not imply graduation. Graduation may enable the feature,
but it must also persist `graduated: true`. A graduated feature remains
independently disableable without losing its page, data or configuration.

The settings page named **实验功能** is only a lifecycle control surface. It may
contain:

- the feature name and concise runtime state;
- an enable/disable control;
- a guarded graduation action and its result.

It must not contain operational tables, approval queues, asset editors,
analytics, history or advanced configuration fields.

## 2. Module Ownership

Every experimental feature must have one explicit owner module. The module owns:

- its configuration schema, defaults, validation and migration;
- runtime start, stop, status and recovery behavior;
- persistence and external side-effect state machines;
- authenticated API routes;
- its complete UI page when operators need to inspect or change the feature;
- tests, operating documentation and rollback instructions.

Shared infrastructure may be injected through narrow interfaces. A feature must
not reach into another module's files, database tables or UI DOM nodes directly.
Cross-feature dependencies must be explicit and validated before activation.

Disabling a module must stop its timers, model work and external writes. It must
not delete data. A never-enabled module must not create its database or mutable
state merely because the process started.

## 3. UI Boundary

If a feature needs more than an enable switch and a short status line, it needs
its own page.

- Before graduation, the page does not occupy product navigation.
- After graduation, its top-level navigation entry becomes visible. Any
  required launch-time value must come from safe defaults, existing validated
  configuration or a guarded setup dialog in the graduation action.
- The page owns all feature-specific settings, data, filters, approval actions,
  errors and empty states.
- Destructive or externally visible actions require explicit confirmation.
- The page must work when the runtime is disabled so operators can inspect data
  and repair configuration.
- A feature page must not depend on hidden controls rendered in the experiment
  settings page.

For the current experimental modules (graduated identity, friend-management and
incident capabilities are documented separately as stable features):

| Feature | Runtime switch | Graduation switch | Owned page |
| --- | --- | --- | --- |
| Relationship state V2 | `relationshipV2.enabled` | `relationshipV2.graduated` | `relationships` / 关系 |

## 4. API And Persistence

- The backend is authoritative for validation and status.
- UI launch actions send minimal feature-only patches; they must not save
  unrelated unsaved settings.
- External writes use durable pre-write state and distinguish confirmed
  success, confirmed failure and unknown outcome.
- Unknown outcomes are never automatically retried.
- IDs remain native strings and are scoped by provider/account where relevant.
- Credentials and protocol tokens never enter UI responses, model prompts or
  ordinary logs.
- Schema additions require defaults that preserve behavior for existing
  installations.

## 5. Graduation Checklist

A feature may be graduated only when all items are satisfied:

1. Runtime, persistence, API and UI have explicit ownership.
2. Disabled mode has no side effects and preserves existing data.
3. Restart, duplicate event and ambiguous external-write behavior are tested.
4. Configuration validation fails closed.
5. The dedicated page covers status, configuration, operations and errors.
6. The experiment page contains only lifecycle controls.
7. Existing installations migrate without silently enabling the feature.
8. Unit/integration tests and UI render tests pass.
9. A rollback artifact or reversible deployment path exists.
10. Production health and the feature-specific status endpoint are verified.
