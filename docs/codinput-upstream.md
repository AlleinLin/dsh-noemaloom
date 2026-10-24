# Original Codinput integration

DSH-Codinput is pinned to version 0.3.5 and commit
`f5449ed247559de2d0f19fc70870864fa93adfcf` from
https://github.com/Witherwithwinter/DSH-Codinput.

`vendor/codinput/` retains the complete acquired checkout, excluding `.git`.
Its added `SOURCE.json` records every original file's SHA-256 and dependency
license identities. The build verifies these original bytes before extracting
the original source. It uses shared React, ReactDOM and JSX runtime modules.
The client is rebuilt from that verified source using the root lockfile's
CodeMirror, marked and patched DOMPurify dependencies; the prebuilt upstream
client is retained as provenance only.

`scripts/codinput-patches.json` contains narrow, hash-checked source adaptations.
They isolate editor events per `EditorView`, bind commands to the correct draft
revision and interaction owner, bound long menus to the viewport, and use the
host's primary color for send/stop controls. Upstream file changes fail the build
until the patch anchors are reviewed. `lib/originals-manifest.json` records the
adaptations and actual bundled dependency identities; delivery auditing rebuilds
the client and checks the resulting bytes and dependency licenses.

The existing original-client owner runs that factory as a formal Cordis plugin.
The host patch registers `dsh-codinput` through
`dsh-noemaloom/original/codinput`. An ESM wrapper forwards the original
CommonJS host exports from an unchanged `.cjs` copy. The retained upstream bundle
patch is evidence only and is not separately loaded.

All original surfaces remain in their native locations: composer takeover
(`conversation.composer.bar`, priority -1), Settings → Codinput, the right-sidebar
Codinput tab, and `/codinput`. There is no Nexus aggregate-page entry. Normal,
floating and side input modes, original CSS/icons, draft/input machine,
attachment/model/permission/voice controls and defaults are preserved, with the
targeted fixes above.
Preferences keep the upstream `dsh-codinput.prefs.v2` key. The default send key is
Ctrl/Cmd+Enter; Enter inserts a line break.

The original implementation installs a global `console.error` diagnostic hook.
The separate gesture adaptation allows native dockkit tab drags through its
capture listener. Original slot retries use timers. A full Desktop restart
remains the reliable boundary when disabling/reloading the enhanced input.

Version 0.3.5 also preserves the host's left/right native input slots, including
the computer-use toggle. Slot entries retain their original components,
ordering, priority and session-bound input actions; they are not copied into
an unrelated settings panel. The renderer regression uses the actual host
SlotCore, original input-seat components and adapted computer-use client.

Desktop verification should cover:

- Native and Codinput composer toggle, preserved draft, single input instance,
  settings persistence, send/newline keys, slash and mention suggestions.
- Normal, floating and right-sidebar input; collapse, reopen and close the tab.
- Native attachments, model/reasoning and permission changes, voice controls.
- Both light/dark themes, Chinese/English, session switching and restart.
- Coexistence with original Reader, Context, the native sidebar and dockkit.

These are verification targets, not a claim that Desktop validation has passed.
The full MIT license, upstream NOTICE and bundled dependency licenses are in
`notices/originals/codinput/`. DOMPurify uses the upstream Apache-2.0 choice.
Licenses and package identities for the rebuilt client's dependencies are under
`notices/originals/codinput/adapted-dependencies/`.
