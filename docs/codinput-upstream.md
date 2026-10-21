# Original Codinput integration

DSH-Codinput is pinned to version 0.3.2 and commit
`a32da33ce4d50616bf490d360ae3dfe784e8aa50` from
https://github.com/Witherwithwinter/DSH-Codinput.

`vendor/codinput/` retains the complete acquired checkout, excluding `.git`.
Its added `SOURCE.json` records every original file's SHA-256 and dependency
license identities. The build verifies these original bytes before extracting
the published factory. It uses shared React, ReactDOM and JSX runtime modules;
CodeMirror, marked and DOMPurify remain in the upstream prebuilt client.
No upstream dependency installation or rebuild is needed.

The existing original-client owner runs that factory as a formal Cordis plugin.
The host patch registers `dsh-codinput` through
`@local/dsh-nexus/original/codinput`. An ESM wrapper forwards the original
CommonJS host exports from an unchanged `.cjs` copy. The retained upstream bundle
patch is evidence only and is not separately loaded.

All original surfaces remain in their native locations: composer takeover
(`conversation.composer.bar`, priority -1), Settings → Codinput, the right-sidebar
Codinput tab, and `/codinput`. There is no Nexus aggregate-page entry. Normal,
floating and side input modes, original CSS/icons, draft/input machine,
attachment/model/permission/voice controls and defaults are unchanged.
Preferences keep the upstream `dsh-codinput.prefs.v2` key. The default send key is
Ctrl/Cmd+Enter; Enter inserts a line break.

The original implementation installs a global `console.error` diagnostic hook
and a document capture listener suppressing dockkit tab-drag gestures. Several
original subscriptions and global handlers lack unload cleanup, and original
slot retries use timers. These behaviors are retained. A full Desktop restart
is the reliable boundary when disabling/reloading this original plugin.

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
