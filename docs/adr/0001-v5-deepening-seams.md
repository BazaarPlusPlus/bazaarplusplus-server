# ADR 0001: V5 deep module seams

Status: Accepted
Date: 2026-08-02

## Context

The V5 Worker must preserve a fixed public wire contract while keeping protocol handling, Bundle validation, persistence decisions, and delivery state transitions independently testable. It is a standalone backend: V4 handlers, storage layouts, bindings, and wire behavior are not architectural inputs unless the V5 contract explicitly requires them.

The architecture therefore uses a small number of explicit seams rather than controller, service, and repository forwarding layers.

## Decision

### Route table and HTTP shell

`src/http/routes.ts` is the complete public route table. `src/http/route-shell.ts` is the sole HTTP exit and owns path and method resolution, `OPTIONS`, request IDs, authentication ordering, route CORS, JSON envelopes, route-specific error headers, and unclassified-error logging. Route handlers return status and body data; they do not construct the final HTTP response.

### Handler dependencies

`src/http/deps.ts` is the only `HandlerDeps` channel. Every domain handler has the required four-argument form `(request, env, requestId, deps)`; `deps` has no default. The production dependency object supplies the clock and lazily constructed download signer. The claim handler reads `deps.signer` before its D1 claim batch so signer-construction failures retain their established behavior.

### Bundle opening

`src/bundle/open.ts` owns bounded prefix and manifest reads, manifest validation, payload layout validation, complete-object digest validation, and Run and Screenshot segment digest validation. `openBundle` returns the validated descriptor, a streaming body for the conditional R2 PUT, and the eventual complete digest. It never decompresses the Run payload and does not own R2 or D1 policy.

### Bundle persistence

`src/modules/bundle-commit.ts` owns immutable-identity decisions and the atomic D1 Bundle commit. It keeps the Ghost eligibility predicate in one definition, associates D1 results with named statements, preserves the first cross-Bundle projection on a duplicate battle identity, and makes the uploader insert the final batch statement. The ingest module owns R2 orchestration and orphan recovery, not persistence branching.

### Delivery convergence

Lazy delivery convergence is claim-only. `POST /bazaardb/deliveries/claim` marks Bundles beyond R2 retention and expired final attempts as failed before claiming a page. Settle does not perform convergence; it validates active lease ownership and applies idempotent per-attempt outcomes.

## Consequences

- Public route additions must update the route table, contract tests, and API reference together.
- Tests can replace time and signing through one dependency object without changing Worker bindings.
- Bundle validation and D1 commit decisions can be tested through public module interfaces.
- Delivery maintenance occurs on claim traffic or through explicit operator action, never through settle or a scheduled Worker handler.

## Historical plan drift

The historical plans `docs/plans/2026-08-02-v5-cross-repo-joint-design.md` and `docs/plans/2026-08-02-v5-server-implementation.md` remain design records, not a current source map. Their illustrative `src/` layout predates the route shell, dependency seam, Bundle opener, and Bundle commit module. The three-argument handler signatures shown in the server implementation plan also predate the required `HandlerDeps` fourth argument. Current source and this ADR define these internal seams; the historical plans continue to describe the V5 product and wire constraints where they have not drifted.
