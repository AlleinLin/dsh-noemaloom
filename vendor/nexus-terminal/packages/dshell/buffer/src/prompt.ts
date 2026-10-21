/**
 * The one system-prompt section this plugin contributes.
 *
 * Two jobs, and the second is why the text is built per assembly rather than
 * kept constant:
 *
 *  - **Say when the pipe applies.** A model told only what a pipe IS never
 *    reaches for one: asked to move something to another machine or to hand
 *    work to another session, it decides it cannot, or improvises a remote copy
 *    with ssh. So the section leads with the triggers and the discipline
 *    (hand it over, do not improvise) and then states the protocol.
 *  - **Say whether one exists, right now.** The section is assembled per turn
 *    with the agent in hand, so it lists this session's live pipes — peer, link
 *    id, and the device the peer runs on — or states plainly that there is
 *    none and a pipe must be asked for. That is the difference between "pipes
 *    exist in this system" and "you have a pipe to the server the user just
 *    named"; without it the model would have to probe with `links` to find out,
 *    which is the step it was skipping.
 */

/** One live pipe, as the standing prompt states it. */
export interface PipeLine {
  readonly linkId: string
  /** The peer's display label (the link's label, else a short session id). */
  readonly peer: string
  /** Where the peer runs: this machine, or a named device and its directory. */
  readonly where: string
  /** What the pipe is for, as either end wrote it; absent means nobody said. */
  readonly purpose: string | undefined
}

/** The standing policy; independent of whether a pipe exists right now. */
const POLICY =
  'Delegation is asynchronous: action="delegate" returns a ticket id at once and the answer arrives later '
  + 'as a new message that reopens this turn — never wait, poll or sleep on it; end the turn or do other '
  + 'work. State the request completely (subject, detail, acceptance criteria): the peer sees only what you '
  + 'send. A request that arrives for you must be claimed and driven to action="finish" (a result) or '
  + 'action="fail" (a reason); one left unsettled is settled as a timeout by the watchdog, which is worse '
  + 'than an honest failure. A delegation may carry grants — files or directories of THIS session opened to '
  + 'the peer, each with read and/or write rights, and each named by the host. That buffer path is the whole '
  + 'contract between the two sessions: /name for an area that is a file, /name/sub/file below one that is a '
  + 'directory. The namespace is per session — the areas of every live grant merge under one root, so a name '
  + 'is taken once. read / edit act inside the granter\'s world in place; download copies a buffer file into '
  + 'your own world (name its dest) and upload pushes one of your files in; files above 32 MiB relay in '
  + 'chunks with sha256 verification automatically. The HOLDER of a grant is the side that acts — handing a '
  + 'file over means granting read and telling the peer to download it, while receiving one means the peer '
  + 'grants write and you upload. action="grants" lists the paths you hold and the ones you opened; paths '
  + 'outside the mapped areas are refused. A pipe may carry a name and a short purpose written by either '
  + 'end — that is what tells you whether a request belongs there. Read it before delegating, and when you '
  + 'learn what a pipe is for that nobody has written down, record it with action="describe" (it is the '
  + 'peer\'s model that will read it next).'

/** The trigger paragraph, which depends on whether there is anywhere to delegate TO. */
function trigger(pipes: readonly PipeLine[]): string {
  return pipes.length > 0
    ? 'A task that belongs to another machine or another session — the user names a server or device, asks '
      + 'for something another session is working on, or the files and environment you need are not in this '
      + 'session\'s own world — should be handed to a peer over a pipe instead of attempted here. Do NOT '
      + 'improvise a remote copy with ssh/scp: the pipe carries the user\'s authorization, its grants expire '
      + 'with the ticket, and the peer acts inside its own world.'
    : 'If a task needs another machine or another session\'s context and this session cannot reach it, say so '
      + 'and ask the user to create a pipe (only the user can) — do not improvise a remote copy with ssh/scp.'
}

/** The live state, so the model never has to guess whether a pipe exists. */
function state(pipes: readonly PipeLine[]): string {
  if (pipes.length === 0) return 'This session has NO cross-session pipe right now.'
  return 'Cross-session pipes live right now for this session (detail: dshell_buffer action="links"):\n'
    + pipes.map(pipe => `- ${pipe.linkId} ↔ ${pipe.peer} · ${pipe.where}`
      + (pipe.purpose === undefined ? '' : ` · purpose: ${pipe.purpose}`)).join('\n')
}

/**
 * The section, for one assembly.
 *
 * @param pipes - this session's live pipes; empty means there is nothing to
 *   delegate over, and the text says so rather than staying silent.
 * @returns the section text.
 */
export function renderBufferPrompt(pipes: readonly PipeLine[]): string {
  return `${state(pipes)}\n\n${trigger(pipes)}\n\n${POLICY}`
}
