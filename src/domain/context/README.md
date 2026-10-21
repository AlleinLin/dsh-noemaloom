# Context/compression integration

`createContextModule(services)` is the single owner of compression state. It
uses the pinned complete acp-kernel in `vendor/acp-kernel`; it does not install
upstream global interceptors or upstream profile patches.

The public module exports `CONTEXT_CAPABILITIES` with action schemas. UI,
native tools and authenticated RPC use the same dispatcher. The formal host
owns all real model sends and the only financial ledger is `usage.record`.
`context.complete` stores an idempotent physical cache observation per
`logicalCallId + attemptId`; it never independently charges an account.

`prepare` accepts `ContextPrepareInput` from `types.ts`, durably stores original
objects before any view can hide them, and returns a frozen plan. The adapter
must send this exact auxiliary plan, then call `complete` even when a send
fails or is cancelled. A network retry gets a new attempt id. The same
provider tail packet updates one observation, and a missing final usage packet
cannot erase a previously reported final sample.

Static prompt, tool order/schema, memory snapshot, route and serialization
versions have independent accepted epochs. A request holds its accepted epoch.
Pending nonurgent changes commit only at a safe boundary. Provider/model/route
changes cannot borrow another route's warm status. Memory background updates
do not automatically rewrite an accepted memory snapshot.

`wire/record` is for the **final provider-serialized bytes**. The pre-serialization
plan artifact is explicitly `projection`. A local byte prefix is evidence of
local stability, never proof of a provider cache hit. No clock, epoch counter,
usage total, request id or random diagnostic text is inserted in the static
model prefix. Unknown usage, cache and tariff values remain unknown.

## Native main-session transaction

The host's real loop owns its request and is not mutated by a read-only
`llm/stream` observer. The native adapter uses the official
`BasicCompactionEngine` subclass/transaction seam:

1. `native/sync` ingests the official current surface nodes and computes the
   same kernel candidate ranges. It records a projection, not a send.
2. `native/propose` runs the real model or accepts model-authored exact ranges,
   dry-runs the full kernel, and saves a prepared proposal. It does not activate
   a block.
3. The host provider commits the selected range through the official compaction
   transaction. Native surface ordering is respected even when replacement
   log sequence numbers are nonmonotonic in surface order.
4. `native/commit` independently reads the official session snapshot. It
   requires the exact summary, shadowed sequences, official three-part
   checkpoint body, checkpoint source and provenance, and complete matching
   start/end lifecycle. The host confirms a successful persistence flush
   before calling it. A caller's claimed success cannot activate a block.
5. `native/abort` retires a failed proposal. `recover` can reconcile an actual
   successful host transaction when the process stopped before the kernel
   receipt was saved. It never resends an unknown paid attempt.

Only `native-compaction-owner` and `native-model-observer` internal authority
can call native actions. Public `compress` for native sessions delegates to
the same host provider outside the context lock, rather than committing a
kernel-only view the real model would never receive.

Native conversion retains exact tool argument strings, provider replay
metadata, message identities, content blocks and attachment refs. Opaque media,
developer state and the durable system head are protected. Retrieval returns
the original native message as well as text. Partial native message selection,
protected gaps and unproven official replacements fail explicitly.

Existing official checkpoints are recursively imported from their authoritative
transactions, including when the plugin is first enabled after compaction.
Receipt failures after a state commit reconcile idempotently without repeating
the fold, epoch increment or paid summary request.

Original objects and CCR content-addressed text live outside the mutable session
envelope. The envelope retains frozen message aliases and CCR placeholder
metadata, and retrieval reads and verifies only its selected source. Ordinary
small tool results are not put into the CCR placeholder index.

`peek` and file recovery leave old prefix bytes intact. Recovery sources stay
addressable through every T1/T2/T3 lineage level. File exports are confined to
the real workspace, refuse overwrites, and are product exports, not machine
or deployment recovery copies.
Native `inline` and `expand` deliver exact source data at the current tail,
through the tool result or the host's durable injection seam. The existing
checkpoint remains active and is marked for possible future refolding; these
operations report `oldPrefixChanged: false` and do not claim native multi-role
history replacement.

## Coordinated validation

Domain integration cases are in `tests/context/context.test.ts`. The complete
upstream kernel tests and golden fixtures are in `vendor/acp-kernel/tests/`.
During the implementation stage these files are written without running
tests/builds. The root project's coordinated verification stage runs them and
records actual results separately; the existence of these files is not a
claim that they passed.
