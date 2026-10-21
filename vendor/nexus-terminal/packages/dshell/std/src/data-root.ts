/**
 * The one host fact dshell's packages have to agree on before they touch a
 * path: where dshell's own files live.
 *
 * dsh resolves its home per call from the environment (`DSH_HOME`, else
 * `~/.dsh`), which is why a plugin never has to ask what it is. dshell's own
 * data root is different: it is a SETTING, so it is known only once the
 * settings service is up and dshell-mode has read the value — and a plugin
 * whose apply finishes before that would otherwise capture the wrong directory
 * and keep it for the life of the process. That is not hypothetical: a reader
 * who moved their data directory found their device registry empty afterwards,
 * with the file sitting intact at the old location, because `dshell-ssh` had
 * built its store first.
 *
 * So the root is published as a service, and the packages that resolve a path
 * during composition wait for it. The declaration lives here, in the shared
 * layer, because the provider (`dshell-mode`) and the waiters (`dshell-ssh`,
 * `dshell-workspace`) are separate packages that must not import each other —
 * and because the seat is small enough to read in full: a promise that settles
 * with the decision.
 *
 * A package need not wait to resolve a path LATER (a route call, a shell spawn,
 * a file listing): those all happen after composition, so the root is settled by
 * then, and reading it where it is used is the cheaper and equally safe rule.
 * What must not happen is resolving a path while the composition is still
 * running and keeping the answer.
 */

/** Service name dshell-mode provides and the path-owning packages wait on. */
export const DSHELL_DATA_ROOT_SERVICE = 'dshellDataRoot'

/** Which input decided the root, in the provider's precedence order. */
export type DshellDataRootSource = 'setting' | 'environment' | 'harness'

/** What the settlement decided about this process's data root. */
export interface DshellDataRootPlan {
  /** The directory dshell's own trees are resolved under. */
  readonly root: string
  /** The input that decided it. */
  readonly source: DshellDataRootSource
}

/** The seat a waiting package reads: a promise, never a captured string. */
export interface DshellDataRootSeat {
  /** Settles with the decision, once the settings document has been read. */
  readonly settled: Promise<DshellDataRootPlan>
}
