# DSH Noemaloom third-party notices

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
- DeepSeek Harness agent-instructions 0.2.1-rc.3 — MIT; adapted for ordered
  first-match project rule files. Source identity and full license are retained
  in `vendor/agent-instructions/`; the runtime entry is `lib/project-rules.js`.
- DeepSeek Harness tool-subagent 0.2.1-rc.3 — MIT; adapted for live authorized
  model discovery, blank optional fields, and maximum supported child reasoning.
  Exact source identity and license are in `vendor/tool-subagent/`;
  the runtime entry is `lib/subagent.js`.
- DeepSeek Harness compaction-basic 0.2.1-rc.3 — MIT; its existing region
  transaction is retained in `vendor/compaction-basic/`, with source hashes and
  an export-only adaptation. Idle manual ranges use the original standalone
  transaction under the real Agent maintenance lock; active-turn compression
  continues through the official engine.
- ThoughtDAG and Synapse — MIT; the full copied license text and specific selected
  source provenance are retained in `assets/notices/thoughtdag/` and
  `assets/notices/synapse/`, including their original copyright statements.
  The published ThoughtDAG runtime is pinned to 0.5.22; its package provenance
  and license are in `notices/originals/thoughtdag/`. Reviewed host/client
  adaptations retain its search, question forms, permission modes and release
  history, while suppressing the standalone plugin installation reminder.
- Runtime UI/transport dependencies: ws 8.18.3 (MIT), qrcode.react 4.2.0
  (ISC, Paul O’Shannessy), its bundled QR Code Generator (MIT, Project Nayuki),
  @xterm/xterm 6.0.0 and @xterm/addon-fit 0.11.0 (MIT). Exact installed
  license texts and provenance are retained in `assets/notices/runtime-dependencies/`.
- DSH-agent-procedures — MIT; the complete user-supplied archive source, original
  templates and four standalone tools are retained in `vendor/agent-procedures/`.
  The explicit native command adapter preserves lazy file lookup and gives user
  read-only instructions priority over the original inbox-write suggestion.
- Nexus-Aethra/Nexus-Terminal 0.1.15 — MIT; the complete user-supplied archive source,
  original dshell UI and Cordis registrations are retained in
  `vendor/nexus-terminal/`. `nexus-adapter/` holds the host process-provider,
  sandbox, PowerShell, path and package-resolution adaptations. Archive hashes
  and full license texts are retained in each vendor tree and runtime notices.
- @xyflow/react 12.11.6 and its graph dependencies — MIT; used by the original
  dshell pipe graph, with license texts copied into `notices/native/` at build.
- cxv117793-blip/dsh-step-pause 0.3.0 — MIT, Copyright (c) 2026
  dsh-step-pause contributors. The periodic pre-step progress behavior is
  adapted into the shared Nexus runtime and scoped settings. Full license,
  verbatim upstream host source and package manifest, commit and file hashes
  are retained in `notices/step-pause/`; adaptations are listed in `SOURCE.json`.
- Witherwithwinter/DSH-Codinput 0.3.5 — MIT, Copyright (c) 2026
  Witherwithwinter; fixed at commit `f5449ed247559de2d0f19fc70870864fa93adfcf`.
  Its entire acquired checkout and byte hashes are in `vendor/codinput/`.
  The original client factory and CommonJS host are preserved without behavior
  or UI changes. Full upstream LICENSE/NOTICE and the exact bundled CodeMirror,
  Lezer, marked, DOMPurify and helper dependency licenses are retained in
  `notices/originals/codinput/`. DOMPurify is used under Apache-2.0 as selected
  by upstream; its alternate MPL-2.0 text is also retained. Upstream NOTICE
  retains DeepSeek Harness visual and style attribution.
- The conversation reflection Markdown renderer also uses the pinned root marked
  15.0.12 (MIT) and DOMPurify 3.4.17 (Apache-2.0 selected). Their exact license
  texts are retained with the shared dependency notices in
  `notices/originals/codinput/`.

Restricted code-review source is not copied. Its user capabilities are independently
implemented. External OpenViking service licensing is distinct from adapter licensing.
No private sessions, credentials, machine profiles, or deployment recovery backups
are intended distribution contents.

The native file editor uses Monaco Editor 0.57.0 (MIT), including its original
third-party notices, marked 14.0.0 (MIT) and DOMPurify 3.4.15 (Apache-2.0
selected; the alternate MPL-2.0 text is also retained). Archive installation uses
tar 7.5.22 (BlueOak-1.0.0), @isaacs/fs-minipass 4.0.1 (ISC), chownr 3.0.0,
minipass 7.1.3 and yallist 5.0.0 (BlueOak-1.0.0), and minizlib 3.1.0 (MIT).
Exact installed license texts, npm integrity values and per-file hashes are
copied to `notices/editor/` by the build.

Debugger/SDK archives are not included in the distribution. The immutable
on-demand manifest `assets/debug-adapters.json` identifies Microsoft js-debug
1.140.0 (MIT), debugpy 1.8.22 (MIT), Samsung netcoredbg 3.2.0-1092 (MIT),
Microsoft Java Debug extension 0.60.0 / server 0.53.2 (EPL-1.0), Eclipse JDTLS
1.63.0 (EPL-2.0), and Eclipse Temurin JRE21.0.12.1+1 (GPL-2.0 with
Classpath Exception). Their original licenses and notices stay inside the
verified local installations. This feature does not distribute or install a
VS Code extension host.

- Wenaixi DSH Superpower 8.0.0 and Ponytail 5.6.2 — MIT. Original DSH skill
  providers, native settings clients and packaged skills are reused. Original
  upstreams are obra/superpowers 7.0.0 and DietrichGebert/ponytail 5.3.2; adapter
  versions are separate. Notices: `notices/originals/` and `assets/methods/`.
- @dragon-talon/dsh-openspec 0.4.0 and @fission-ai/openspec 1.14.3 — MIT.
  Canonical skills and aliases are retained; CLI paths are adapted for the
  packaged installation. Dependency notices: `notices/workflows/`.
- dsh-karpathy-methodology 0.1.0 — MIT provider. Canonical
  multica-ai/andrej-karpathy-skills 1.0.0 by forrestchang is inspired by Karpathy,
  not an official Karpathy plugin. Upstream metadata declares MIT but has no
  separate LICENSE. Original metadata: `assets/methods/karpathy/`.
- dsh-ops 0.4.1 — MIT AND Apache-2.0. Native shell/file/PTC/discovery and optional original
  panel/TUI are composed once using upstream defaults.
- Scorp1o117/dsh-motion-ui 0.8.7 — MIT. Published native tools, skills, panels and
  media renderers are preserved, with a separate theme/reduced-motion adapter.
  The npm integrity is the runtime identity; the eight internal modules that
  differ from Git HEAD are recorded individually in the upstream review.
- zsjs110110-cpu/dsh-cross-session-approval 0.3.10 — MIT. Original ten tools and
  permission limits are retained; agent messages use the shared mailbox rather
  than impersonating human messages. Complete license and npm file identities
  are retained in `notices/originals/cross-session-approval/`.
- LJL454/dsh-computer-use 1.40.3 — MIT. Complete source-only Windows/backend/CDP
  runtime at commit `20bfa1442bbe6f9f43a3e6ebcd9bff4403ecce7a`, preserved in
  `vendor/computer-use/` with per-file hashes. Authenticated routes and native
  sandbox/approval integration are generated separately from original source.
- Yu-tao-Li/dsh-computer-use-win 0.5.1 — tracked comparison source at commit
  `d9e4605c4fe45215555da386a4a84a699443791a`. This second controller is not
  installed concurrently; its upstream identity and comparison remain in the
  source ledger and maintenance inventory.
