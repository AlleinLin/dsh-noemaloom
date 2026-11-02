/**
 * The dsh surface dshell consumes, and the reader that measures it against a checkout.
 *
 * Two things here, both about a NAME rather than a version:
 *
 * - DSHELL_SURFACE is every upstream identifier dshell's code reaches for: ctx service
 *   keys, SlotMap slot ids, session event names, and the /api/dshell/* routes. It is
 *   hand-written because it is a claim about what dshell uses; a generated list would
 *   only repeat the source back at itself and could never notice a name that vanished
 *   from both sides at once.
 * - readUpstreamSurface reads the same names out of a dsh checkout, from the catalogs
 *   dsh generates FOR ITSELF (SERVICE_API, the client slot catalog) plus the
 *   KNOWN_SESSION_EVENT_TYPES set. Reading upstream's own generated catalogs rather
 *   than re-parsing 'declare module' blocks and 'interface SlotMap' bodies is
 *   deliberate: those catalogs are the machine-readable projection dsh maintains and
 *   freshness-gates for its own doc-sync, so a hand-rolled parser here would be a
 *   second, weaker reading of the same source.
 *
 * The gate exists because a dsh release can drop or rename any of these while dshell's
 * own peer ranges still admit it -- public APIs are pre-stable, so the declaration
 * never promises the name. A missing name is the failure the version gate cannot see:
 * the plugin installs, boots, and silently stops doing the one thing that name was for.
 */

/** A service dshell reaches through the ctx property, ctx.get(), or an inject declaration. */
export interface ServiceDependency {
  /** The ctx key, e.g. 'terminals'. */
  readonly key: string
  /** Where dshell reads it, as packages/dshell/<pkg>/... -- the place to look when this fails. */
  readonly usedAt: string
  /**
   * Whether the name is a seat dshell publishes itself rather than one dsh ships.
   *
   * dshell provides eight seats of its own (dshellDeviceFs, dshellHostCopy,
   * dshellPtyStream, dshellSshRouting, dshellTerminalBridge, dshellTerminalMode,
   * dshellBufferCore, dshellDataRoot). A gate that demanded those from dsh would fail
   * on every checkout, so they are excluded from the check. They stay listed here,
   * marked own, because an inventory that silently dropped half of what dshell injects
   * would not be an inventory.
   */
  readonly own: boolean
}

/** A client SlotMap key dshell registers into or renders. */
export interface SlotDependency {
  /** The slot id, e.g. 'sidebar.right.pane.tab'. */
  readonly key: string
  /** Where dshell reads or renders it. */
  readonly usedAt: string
}

/** Every upstream name dshell's code depends on, grouped by kind. */
export interface SurfaceClaim {
  /** Host and client services, dshell's own seats included but marked. */
  readonly services: readonly ServiceDependency[]
  /** Client slot ids. */
  readonly slots: readonly SlotDependency[]
  /** Session event discriminants dshell matches on. */
  readonly events: readonly string[]
  /** HTTP paths dshell serves itself; listed as a claim so the contract stays in one place. */
  readonly routes: readonly string[]
}

/**
 * The upstream surface dshell depends on.
 *
 * A hand-maintained list, and it has to stay one: it is the assertion, not a
 * derivation. Adding a ctx read or a slot registration without adding it here leaves
 * that name ungated -- a gap in the claim, not a passing check.
 */
export const DSHELL_SURFACE: SurfaceClaim = {
  services: [
    { key: 'agents', usedAt: 'packages/dshell/commands/src/index.ts', own: false },
    { key: 'commands', usedAt: 'packages/dshell/commands/src/index.ts', own: false },
    { key: 'configForms', usedAt: 'packages/dshell/ssh/src/client/index.ts', own: false },
    { key: 'connection', usedAt: 'packages/dshell/files/src/client/index.ts', own: false },
    { key: 'fs', usedAt: 'packages/dshell/ssh/src/fs-routing.ts', own: false },
    { key: 'inputTriggers', usedAt: 'packages/dshell/mode/src/client/index.ts', own: false },
    { key: 'locale', usedAt: 'packages/dshell/mode/src/client/controls.ts', own: false },
    { key: 'modelDirectories', usedAt: 'packages/dshell/mode/src/client/index.ts', own: false },
    { key: 'remote', usedAt: 'packages/dshell/std/src/contracts.ts', own: false },
    { key: 'sandbox', usedAt: 'packages/dshell/ssh/src/index.ts', own: false },
    { key: 'sandboxPolicy', usedAt: 'packages/dshell/ssh/src/index.ts', own: false },
    { key: 'sessionController', usedAt: 'packages/dshell/files/src/index.ts', own: false },
    { key: 'sessionQuery', usedAt: 'packages/dshell/usage/src/index.ts', own: false },
    { key: 'sessions', usedAt: 'packages/dshell/mode/src/client/index.ts', own: false },
    { key: 'settings', usedAt: 'packages/dshell/mode/src/index.ts', own: false },
    { key: 'shell', usedAt: 'packages/dshell/ssh/src/shell-routing.ts', own: false },
    { key: 'sidebarRightTabs', usedAt: 'packages/dshell/files/src/client/index.ts', own: false },
    { key: 'slots', usedAt: 'packages/dshell/mode/src/client/index.ts', own: false },
    { key: 'subprocess', usedAt: 'packages/dshell/ssh/src/transport/transport.ts', own: false },
    { key: 'terminals', usedAt: 'packages/dshell/terminal-bridge/src/index.ts', own: false },
    { key: 'tools', usedAt: 'packages/dshell/commands/src/index.ts', own: false },
    { key: 'uiConversation', usedAt: 'packages/dshell/conversation/src/client/index.ts', own: false },
    { key: 'uiSession', usedAt: 'packages/dshell/mode/src/client/index.ts', own: false },
    { key: 'workspaces', usedAt: 'packages/dshell/mode/src/client/index.ts', own: false },
    { key: 'deviceFs', usedAt: 'packages/dshell/ssh/src/device-fs-provider.ts', own: true },
    { key: 'dshellBufferCore', usedAt: 'packages/dshell/buffer/src/index.ts', own: true },
    { key: 'dshellHostCopy', usedAt: 'packages/dshell/terminal-bridge/src/index.ts', own: true },
    { key: 'dshellPtyStream', usedAt: 'packages/dshell/mode/src/client/index.ts', own: true },
    { key: 'dshellSshRouting', usedAt: 'packages/dshell/ssh/src/index.ts', own: true },
    { key: 'dshellTerminalBridge', usedAt: 'packages/dshell/terminal-bridge/src/index.ts', own: true },
    { key: 'dshellTerminalMode', usedAt: 'packages/dshell/mode/src/index.ts', own: true },
  ],
  slots: [
    { key: 'conversation.input.left', usedAt: 'packages/dshell/mode/src/client/index.ts' },
    { key: 'conversation.input.overlay', usedAt: 'packages/dshell/mode/src/client/index.ts' },
    { key: 'conversation.session.header.actions', usedAt: 'packages/dshell/mode/src/client/index.ts' },
    { key: 'plugins.row.config', usedAt: 'packages/dshell/mode/src/client/index.ts' },
    { key: 'settings.section', usedAt: 'packages/dshell/usage/src/client/index.ts' },
    { key: 'shell.overlay', usedAt: 'packages/dshell/buffer/src/client/index.ts' },
    { key: 'sidebar.right.pane.tab', usedAt: 'packages/dshell/files/src/client/index.ts' },
    { key: 'sidebar.right.pane.tab.title', usedAt: 'packages/dshell/files/src/client/index.ts' },
    { key: 'sidebar.workspaces.session.row.action', usedAt: 'packages/dshell/ssh/src/client/index.ts' },
  ],
  events: [
    'agent/inbox/spliced',
    'assistant/message',
    'command/done',
    'command/run',
  ],
  routes: [
    '/api/dshell/buffer',
    '/api/dshell/device-detail',
    '/api/dshell/device-metrics',
    '/api/dshell/dirs',
    '/api/dshell/files',
    '/api/dshell/locale',
    '/api/dshell/pty',
    '/api/dshell/ssh',
    '/api/dshell/stream',
    '/api/dshell/stream/send',
    '/api/dshell/terminal-mode',
    '/api/dshell/transfer',
    '/api/dshell/usage',
  ],
}

/** What a dsh checkout actually declares, read from its own generated catalogs. */
export interface UpstreamSurface {
  /** ctx keys from the cordis API catalog. */
  readonly services: ReadonlySet<string>
  /** Client SlotMap ids from the slot catalog. */
  readonly slots: ReadonlySet<string>
  /** Session event discriminants the build understands. */
  readonly events: ReadonlySet<string>
}

/** The files the reader needs, relative to a dsh checkout root. */
export const UPSTREAM_SURFACE_FILES = {
  /** SERVICE_API and INHERITED_CTX_API. */
  services: 'packages/extensions/tool-cordis/src/api-catalog.ts',
  /** The generated ClientSlotEntry list naming every SlotMap key. */
  slots: 'packages/extensions/cordis-client-runner/src/client/slot-catalog.ts',
  /** KNOWN_SESSION_EVENT_TYPES. */
  events: 'packages/core/session/src/known-event-types.ts',
} as const

/** The packages tree a checkout's service declarations are read from. */
export const UPSTREAM_PACKAGES_ROOT = 'packages'

// A `declare module '@deepseek-ai/cordis'` block that merges `Context`, up to the
// 800 characters that separate the declaration from the interface it introduces.
const CONTEXT_MERGE = /declare module '@deepseek-ai\/cordis'([\s\S]{0,800})/g

/**
 * Read every source file under a checkout's `packages` tree that could declare a context key.
 *
 * @param listFiles - every non-test `.ts` file under `packages`, relative to the root.
 * @param readFile - reads one such file.
 * @returns the texts that mention cordis, which are the only ones that can carry a merge.
 */
export function readServiceDeclarations(
  listFiles: () => readonly string[],
  readFile: (path: string) => string,
): string[] {
  const texts: string[] = []
  for (const relative of listFiles()) {
    if (!relative.endsWith('.ts') || relative.endsWith('.spec.ts')) continue
    const text = readFile(relative)
    if (!text.includes('interface Context')) continue
    texts.push(text)
  }
  return texts
}

/**
 * The `ctx` keys a set of sources merge into cordis's `Context` interface.
 *
 * The merge is a brace-delimited interface body whose members sit at four spaces. The
 * body is read by matching braces rather than by a regex, because a member's own JSDoc
 * may contain braces and a preceding comment shifts the lines a declaration starts at.
 *
 * @param texts - sources known to mention cordis.
 * @returns the declared `ctx` keys.
 */
export function readCordisContextKeys(texts: readonly string[]): ReadonlySet<string> {
  const keys = new Set<string>()
  for (const text of texts) {
    for (const merge of text.matchAll(CONTEXT_MERGE)) {
      const chunk = merge[1]!
      const declaration = chunk.indexOf('interface Context {')
      if (declaration === -1) continue
      const open = chunk.indexOf('{', declaration)
      let depth = 0
      let close = -1
      for (let index = open; index < chunk.length; index += 1) {
        if (chunk[index] === '{') depth += 1
        else if (chunk[index] === '}') {
          depth -= 1
          if (depth === 0) { close = index; break }
        }
      }
      if (close === -1) continue
      for (const member of chunk.slice(open, close).matchAll(/^ {4}([A-Za-z_$][A-Za-z0-9_$]*)\s*[?:]/gm)) {
        keys.add(member[1]!)
      }
    }
  }
  return keys
}
/**
 * Collect the quoted values that follow every match of a pattern.
 *
 * A catalog is generated data, so its entries are uniform and a scan is exact enough
 * to read them. The alternative -- importing the catalog module -- would drag dsh's
 * TypeScript through this repository's compiler, and these catalogs are the one place
 * where a plain text read answers the same question.
 *
 * @param text - catalog source.
 * @param pattern - matcher whose first capture group is the quoted value.
 * @returns the captured values, in file order.
 */
export function quotedValues(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map(match => match[1]!)
}

/**
 * Read a dsh checkout's declared surface.
 *
 * @param readFile - reads a path relative to the checkout root, throwing when absent.
 * @param listFiles - every source file under the checkout's `packages` tree. The
 *   browser-side services are declared by merging cordis's `Context` interface rather
 *   than listed in a generated catalog, so they are found by walking these.
 * @returns the declared services, slots, and session events.
 * @throws when a catalog is missing or carries no entries: a checkout that cannot
 *   answer is a gate that cannot judge, and empty sets would make every assertion
 *   below pass.
 */
export function readUpstreamSurface(
  readFile: (path: string) => string,
  listFiles: () => readonly string[],
): UpstreamSurface {
  const servicesText = readFile(UPSTREAM_SURFACE_FILES.services)
  const slotsText = readFile(UPSTREAM_SURFACE_FILES.slots)
  const eventsText = readFile(UPSTREAM_SURFACE_FILES.events)

  // Both catalog arrays wrap each entry in an object opened at two spaces and spell
  // its `key` at four, so one pattern reads SERVICE_API and INHERITED_CTX_API alike.
  // Slot catalog entries follow the same two-then-four nesting. The event list is a
  // flat literal array, whose members sit at two spaces.
  const catalogServices = quotedValues(servicesText, /^ {4}key: '([^']+)'/gm)
  // A service is also reachable when its package merges the cordis `Context` interface
  // rather than appearing in the generated catalog: that is how every BROWSER-side
  // service is declared (`slots`, `uiConversation`, `locale`, ...). The checkout is
  // walked for those merges, so a client service dshell injects is gated exactly as a
  // host one is. Only files that mention cordis are scanned, which keeps this to the
  // handful of packages that declare a service at all.
  const mergedServices = readCordisContextKeys(readServiceDeclarations(listFiles, readFile))
  const services = new Set([...catalogServices, ...mergedServices])
  const slots = new Set(quotedValues(slotsText, /^ {4}key: '([^']+)'/gm))
  const events = new Set(quotedValues(eventsText, /^ {2}'([^']+)',/gm))

  // A browser service that no walk reaches is the quiet failure: the catalog half
  // alone would leave `slots`, `uiConversation` and `locale` unguarded while every
  // host claim still passed. `listFiles` is therefore required, and an empty walk is
  // refused rather than tolerated.
  if (catalogServices.length === 0) {
    throw new Error(
      'the dsh checkout declared no service names; its catalog format changed and this gate can no longer read it',
    )
  }
  if (mergedServices.size === 0) {
    throw new Error(
      'no service declarations were found by walking the checkout; the walk itself is broken, not the checkout',
    )
  }
  const groups: readonly (readonly [string, ReadonlySet<string>])[] = [
    ['service', services], ['slot', slots], ['event', events],
  ]
  for (const [kind, set] of groups) {
    if (set.size === 0) {
      throw new Error(
        'the dsh checkout declared no ' + kind + ' names; its catalog format changed and this gate can no longer read it',
      )
    }
  }
  return { services, slots, events }
}

/** One name a checkout does not declare, with the claim that named it. */
export interface SurfaceGap {
  /** Which claim failed. */
  readonly kind: 'service' | 'slot' | 'event'
  /** The missing name. */
  readonly name: string
  /** Where dshell uses it. */
  readonly usedAt: string
}

/**
 * Compare the claim against what the checkout declares.
 *
 * @param claim - the names dshell depends on.
 * @param declared - what the checkout reports.
 * @returns every name the checkout does not declare, sorted for a stable diff.
 */
export function missingSurface(claim: SurfaceClaim, declared: UpstreamSurface): SurfaceGap[] {
  const gaps: SurfaceGap[] = []
  for (const service of claim.services) {
    if (service.own) continue
    if (!declared.services.has(service.key)) {
      gaps.push({ kind: 'service', name: service.key, usedAt: service.usedAt })
    }
  }
  for (const slot of claim.slots) {
    if (!declared.slots.has(slot.key)) gaps.push({ kind: 'slot', name: slot.key, usedAt: slot.usedAt })
  }
  for (const event of claim.events) {
    if (!declared.events.has(event)) gaps.push({ kind: 'event', name: event, usedAt: 'packages/dshell/mode/src/client/block-view.ts' })
  }
  return gaps.sort((left, right) => (left.kind + left.name).localeCompare(right.kind + right.name))
}
