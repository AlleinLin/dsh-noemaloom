# Session recovery corrections, 2026-10-22

Source evidence was a user-provided session export. The original conversation
and business content are not included in this repository.

## Manual compact versus active request maintenance

The session showed a manual command registered while a turn was active. Before
the official compaction start was recorded, automatic maintenance failed with
`CTX_NATIVE_BUSY`. Another manual command also failed, and the first eventually
reported an input that could not fit the summary model.

The former `compactNow` path acquired the Nexus lane and synchronized the source
before calling the host engine's maintenance admission. It could therefore hold
the lane required by the running turn. `compactNow` now acquires the actual
`Agent.runMaintenance` admission before any lane, synchronization or model work.
Public `agent.status === 'idle'` is not sufficient: the native API also excludes
an existing maintenance job and pending input.

The summary range is bounded against the selected summary model before opening
a transaction. It uses the pinned upstream selection and serialization helpers,
then selects the largest fitting complete prefix. A cut must preserve whole
messages and tool-call/result pairs. No fitting prefix means an explicit
`CTX_SUMMARY_INPUT_LIMIT` without a model request or transaction marker. The
unselected source tail and initiating command identity remain intact.

The pinned helper implementation changes only its export list. Provenance and
derived hashes are recorded in `vendor/compaction-basic/SOURCE.json` and
`sources.lock.json`.

## Mailbox argument handling

The export contained 18 failed sends, including 15 attempts with `reply_to: ""`.
Those requests never entered the mailbox. An empty optional reply link is now
equivalent to omission, including for the idempotency fingerprint.

Recipient spellings `target` and `agent_id` are compared by resolved identity,
so `parent` and its exact session ID agree. A real recipient conflict remains
rejected. Nonempty reply IDs remain strictly checked against messages received
from the selected recipient. A business request ID, an agent ID or `parent`
cannot become a fabricated reply link.

Tool descriptions, field descriptions, runtime guidance and errors now distinguish
new sends, replies and idempotency keys, with explicit corrective steps.

## Checks

The regression suite includes the real native Agent maintenance admission and
transaction implementation, bounded source selection with retained tool pairs,
no-fitting-prefix behavior, mailbox omission and alias handling, and scoped
retry policy configuration. See `docs/request-retry.md` for the new policy.
