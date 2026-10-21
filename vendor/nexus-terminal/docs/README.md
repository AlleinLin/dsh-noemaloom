# dshell documents

Read in order when onboarding; jump straight to a specific doc when
making a targeted change.

| Doc | Read when |
|---|---|
| [`dshell-design.md`](./dshell-design.md) | Starting from the goal, the non-goals, and the six design decisions |
| [`dshell-architecture.md`](./dshell-architecture.md) | Writing or reviewing code: wire protocol, Cordis surface, package layout |
| [`dshell-roadmap.md`](./dshell-roadmap.md) | Picking the next phase to implement |
| [`dshell-packages.md`](./dshell-packages.md) | Looking up which plugin owns a feature |
| [`dshell-upgrade-0.1.6.md`](./dshell-upgrade-0.1.6.md) | Moving the dsh version: the adaptation and testing roadmaps for one upgrade |
| [`dshell-handoff-2026-10.md`](./dshell-handoff-2026-10.md) | Taking the work over from someone: live state, uncommitted changes, open items, demo assets |

## Document roles

- `dshell-design.md` is normative for *decisions*. Code that contradicts
  any of its six decisions is wrong.
- `dshell-architecture.md` is normative for *shapes*. Wire frame types,
  Cordis keys, file layout, and CSS conventions are locked there.
- `dshell-roadmap.md` is the sequence of phases. Each phase ends with
  an acceptance check.
- `dshell-packages.md` is the plugin inventory, keyed by the dsh
  service each plugin depends on and the phase that introduces it.
- `dshell-upgrade-0.1.6.md` is *one migration*, not a standing document: it
  carries the phases for moving dshell onto a specific upstream tag, plus the
  testing work that makes the next move cheaper. Read it when the harness
  version changes; fold its lessons back into the four above once the target
  version is the one `main` runs.
- `dshell-handoff-2026-10.md` is *one handover*, not a standing document: it
  records the live state (what is released, what sits uncommitted, what is
  blocked and why) with the readings that were true on 2026-10-19. It goes
  stale as soon as the branch is committed or released — rewrite it at the next
  handover rather than maintaining it.

## Source of truth for dsh

All dsh references in this repo resolve to the local checkout under
`dsh/` (untracked; see the repo-root `.gitignore`). When citing dsh
sources, prefer the package README over deep source files; the
READMEs are where dsh's contract is stated.

## The user-facing README comes in two languages

`README.md` (English) and `README.zh-CN.md` (简体中文) are the same document for people who *use*
dshell, as opposed to the four docs above, which are for people changing it. They are the front page
GitHub renders.

Both open with a one-line switcher (`**English** · [简体中文](./README.zh-CN.md)`), and both share the
screenshots and diagrams under `docs/images/` — so a change to either one must be mirrored in the
other **in the same commit**. The mermaid diagrams are duplicated per language rather than shared,
because the labels are prose; keep the diagram shapes identical when you translate one.

## How to update these documents

1. Editing a decision: update `dshell-design.md` first, then
   `dshell-architecture.md` if a shape changed, then
   `dshell-roadmap.md` if the phase plan moved, then
   `dshell-packages.md` if a plugin gained or lost responsibility.
2. Adding a new plugin: edit `dshell-packages.md` first, then
   `dshell-roadmap.md` to record the phase that brings it in, then
   `dshell-architecture.md` if it introduces a new Cordis key or wire
   shape.
3. Renaming or removing anything: search all four docs for the old
   name and update in the same commit.
4. Changing user-visible behaviour: update both READMEs, and refresh the
   screenshots if the affected screen changed.