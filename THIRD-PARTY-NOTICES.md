# DSH Nexus third-party notices

This distribution contains or adapts components from multiple upstream projects.
It is not licensed as a single blanket MIT work. See `notices/`, individual
`vendor/**/LICENSE*`, `assets/**/LICENSE*`, and `sources.lock.json` for actual paths,
versions, copyright notices, source identities, and modifications.

- billion-context / acp-kernel — source: https://github.com/ranxianglei/billion-context.
  Preserve its complete license, attribution, and product-surface attribution terms.
- FuRongJun-1999/dsh-memory `md_cg` — MIT; original source and license retained.
- omdsh-dev/dsh-mnemon providers — MIT; drivers are adapted to Nexus-owned transport,
  scope, secret references, cancellation, and lifecycle.
- Anionex/dsh-turn-rewind — BSD-3-Clause; recovery core and notice retained.
- MichengAI/dsh-agency-agents — assets and implementation have component notices.
- qiudeng7/how-to-lint and qiudeng7/software-engineering-workflow — MIT;
  unverified SVG submodule/media is not assumed to inherit the parent license.
- tt-a1i/archify — reused diagram implementation; third-party fonts/media excluded.
- Metis 2.0.2 — MIT with Wholiver and Mario Zechner copyrights; selected policies and
  templates only, no second runtime or fixed-PASS controller.
- dsh-web root and subpackages — mixed Apache-2.0/BSD notices, retained per component.
- DeepSeek Harness agent-instructions 0.2.1-rc.2 — MIT; adapted for ordered
  first-match project rule files. Source identity and full license are retained
  in `vendor/agent-instructions/`; the runtime entry is `lib/project-rules.js`.
- DeepSeek Harness tool-subagent 0.2.1-rc.2 — MIT; adapted for live authorized
  model discovery, blank optional fields, and maximum supported child reasoning.
  Exact source identity and license are in `vendor/tool-subagent/`;
  the runtime entry is `lib/subagent.js`.
- DeepSeek Harness compaction-basic 0.2.1-rc.2 — MIT; its existing region
  transaction is retained in `vendor/compaction-basic/`, with source hashes and
  an export-only adaptation. Idle manual ranges use the original standalone
  transaction under the real Agent maintenance lock; active-turn compression
  continues through the official engine.
- ThoughtDAG and Synapse — MIT; the full copied license text and specific selected
  source provenance are retained in `assets/notices/thoughtdag/` and
  `assets/notices/synapse/`, including their original copyright statements.
- Runtime UI/transport dependencies: ws 8.18.3 (MIT), qrcode.react 4.2.0
  (ISC, Paul O’Shannessy), its bundled QR Code Generator (MIT, Project Nayuki),
  @xterm/xterm 6.0.0 and @xterm/addon-fit 0.11.0 (MIT). Exact installed
  license texts and provenance are retained in `assets/notices/runtime-dependencies/`.
- DSH-agent-procedures — MIT; the complete user-supplied archive source, original
  templates and four standalone tools are retained in `vendor/agent-procedures/`.
  The explicit native command adapter preserves lazy file lookup and gives user
  read-only instructions priority over the original inbox-write suggestion.
- Nexus-Aethra/Nexus-Terminal 0.1.14 — MIT; the complete user-supplied archive source,
  original dshell UI and Cordis registrations are retained in
  `vendor/nexus-terminal/`. `nexus-adapter/` holds the host process-provider,
  sandbox, PowerShell, path and package-resolution adaptations. Archive hashes
  and full license texts are retained in each vendor tree and runtime notices.
- @xyflow/react 12.11.6 and its graph dependencies — MIT; used by the original
  dshell pipe graph, with license texts copied into `notices/native/` at build.

Restricted code-review source is not copied. Its user capabilities are independently
implemented. External OpenViking service licensing is distinct from adapter licensing.
No private sessions, credentials, machine profiles, or deployment recovery backups
are intended distribution contents.
