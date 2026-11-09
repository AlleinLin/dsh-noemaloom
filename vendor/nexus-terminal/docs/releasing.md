# Releasing dshell

Eleven packages, one version, carried together. Every release also gets a git
tag and a GitHub Release page, and those are three separate acts — `0.1.8`
through `0.1.13`, `0.1.16` and `0.1.17` shipped to npm without the last one,
which is why the Releases page still advertises `0.1.15` as **Latest**.

## The five steps

Each step is verifiable on its own; skipping one produces a release that exists
somewhere and not everywhere.

1. **Bump.** All eleven `packages/dshell/*/package.json` move to the same
   version. Land it through a PR like any other change — the version a user
   installs and the version `main` records have to agree.
2. **Publish.** `pnpm publish --registry=https://registry.npmjs.org/` in
   dependency order, `std` first and `bundle` last. Tag `latest` for a stable
   release, `alpha` for a preview. Verify each with
   `npm view <pkg>@<version> version`; propagation lags.
3. **Tag.** `git tag dshell-v<version>` on the merge commit and push it.
   A published npm version with no tag is a version nobody can find the source
   of.
4. **Release notes.** `gh release create` with the six-section body below.
   `--latest` on the newest stable release, and **never** on a backfill — a
   backfilled `0.1.7` must not take **Latest** from the current version.
5. **Verify the published artifact.** Install from the registry into a clean
   directory rather than trusting the local build, and boot it once on the dsh
   version the release claims to support.

## The release body

Six sections, in Chinese, matching `0.1.15` onward. The heading line is
`<version> — <one thing this release is about>`, then a short paragraph naming
the dsh version the release needs.

| Section | What it holds |
|---|---|
| `## 一句话` | The release in one sentence, for someone deciding whether to upgrade |
| `## 新能力` | What a user can newly do, phrased as the act, not the implementation |
| `## 修好的问题` | What was broken, how it presented, and why it happened — this is the part users quote back |
| `## 兼容与升级` | Breaking changes, the dsh window, and the exact upgrade commands |
| `## 30 秒自检` | Three steps a reader can run to believe the release |
| `## 已知边界` | What this release deliberately does not do |

Write the failure, not the fix. "表头点了没反应" tells a reader whether they were
hitting it; "修复了表头排序" does not.

## The dsh window is part of the release

dshell declares every `@deepseek-ai/dsh-*` peer as a **window** rather than a
list (`>=0.2.1-rc.2 <0.2.3-0` today), and dsh checks every declared peer against
its own version, skipping the whole bundle on a mismatch. So:

- widening the window is a reason to cut a release, not a follow-up;
- the window belongs in `## 兼容与升级`, because a user on a newer dsh needs to
  know whether this release installs at all;
- `node scripts/sync-host-range.mjs --check` must pass before publishing — a
  package carrying an older range silently disables its row in a profile.

## Never republish a version

npm refuses it, and deprecating is the only way to withdraw one. A release with
a defect gets a new version; `npm deprecate` is for telling users why they
should move off the old one.

## Checking for gaps

The Releases page is the only place a user looks for "what is the latest", so it
drifts silently. List what exists and compare:

```sh
git tag --list 'dshell-v*'        # what was cut
gh release list --limit 30        # what has a page
npm view @nexus-aethra/dshell-bundle dist-tags   # what users install
```

Any tag without a release is a gap to backfill; any `latest` on npm newer than
the newest release means the newest release was never written.
