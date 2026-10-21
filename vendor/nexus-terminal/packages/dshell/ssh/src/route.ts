/**
 * The SSH device route: one exact `/api` endpoint behind dsh's existing trust
 * and authentication fence, mirroring the session panel's shape.
 *
 * It carries the operations that must not live in the settings document —
 * storing a private key, testing a connection — and reports the device list
 * plus the session assignments after every request, so the UI's snapshot is
 * always the committed one.
 */

import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { Context } from '@deepseek-ai/cordis'
import type { DshellSshTranslate } from './host-locales.js'
import { listLocalKeys, readLocalKey } from './local-keys.js'
import { listTrustedHostKeys, probeHostKey, revokeTrustedHostKeys } from './host-key.js'
import { VaultLockedError } from './vault.js'
import { DSHELL_SSH_PATH, type SshRequest, type SshResponse } from './protocol.js'
import type { SshRouter } from './router.js'

/** What the route needs from the plugin that owns it. */
export interface SshRouteDeps {
  readonly router: SshRouter
  /** Host context, so the connection test can spawn a process. */
  readonly ctx: Context
  /**
   * This package's host copy, bound to the language the browser reported — the
   * settings card renders a refusal verbatim, so it must match the screen.
   */
  readonly t: DshellSshTranslate
}

/** JSON response in the shape the device UI parses. */
function respond(body: SshResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * Replace one session's live shell after its assignment changed.
 *
 * A session's terminal is spawned when it is opened, and the assignment can be
 * recorded after that — the creation page writes it a round trip after the
 * session exists — so a shell already running somewhere has to be replaced for
 * the new plan to mean anything. Reached through the service name rather than
 * an import: the bridge may load after this plugin, and a composition without
 * it (no terminal) has nothing to replace. A session whose terminal never
 * spawned needs nothing either: the next attach asks for a plan, and gets the
 * new one.
 *
 * @param ctx - host context, for the terminal bridge's service.
 * @param sessionId - the session whose shell to replace.
 */
async function respawnShell(ctx: Context, sessionId: string): Promise<void> {
  const bridge = ctx.get('dshellTerminalBridge') as
    | { respawnMain?: (id: string) => Promise<void> }
    | undefined
  await bridge?.respawnMain?.(sessionId).catch(() => { /* the panel reports the spawn */ })
}

/**
 * The vault face of a reply: groups and credentials together.
 *
 * Always both, because a group's lock state is only meaningful next to the
 * credentials it holds, and answering one without the other is how a card ends
 * up offering a token prompt for a plain group.
 */
async function vaultFace(deps: SshRouteDeps): Promise<Pick<SshResponse, 'groups' | 'credentials'>> {
  return { groups: await deps.router.vault.list(), credentials: await deps.router.credentials.list() }
}

/** Bind the route to the device registry. */
export function createSshRoute(deps: SshRouteDeps): ConnectionFetchRoute {
  const state = async (): Promise<Omit<SshResponse, 'error' | 'testResult'>> => ({
    devices: await deps.router.list(),
    bindings: await deps.router.assignments(),
  })

  const handle = async (request: Request): Promise<SshResponse> => {
    const input = request.method === 'GET'
      ? { action: 'list' } as const
      : await request.json() as SshRequest
    switch (input.action) {
      case 'list':
        // The vault face rides along: the client's snapshot starts empty and a
        // reply without it would leave the panel — and the device form's
        // credential picker — reading as an empty vault until some mutation
        // happened to carry one.
        return { ...await state(), ...await vaultFace(deps) }
      case 'save':
        await deps.router.saveDevice(input.device)
        return await state()
      case 'delete':
        await deps.router.removeDevice(input.deviceId)
        return await state()
      case 'test': {
        // Run the test BEFORE reading state, for the same reason the install
        // branch does: the test records the helper's state onto the device
        // (see `surveyHelper`), and `state()` is what reads those records
        // back. Evaluating it first answered with the pre-test list, so the
        // card kept showing the previous status until something else
        // refreshed it.
        //
        // With a remote directory the test also creates it: the dialog runs
        // this before creating the session, so a device that answers but
        // cannot host the directory is reported here, not after.
        const testResult = await deps.router.test(input.deviceId, input.remoteRoot ?? null)
        return { ...await state(), testResult }
      }
      case 'mount':
        return { ...await state(), mountPath: await deps.router.mountPath(input.deviceId, input.remoteRoot ?? null) }
      case 'bind': {
        // The remote directory is created inside `bind`, before the assignment
        // is recorded: the assignment is what makes a session routable, and the
        // shell it starts must not find the directory still missing.
        const before = deps.router.assignmentForSession(input.sessionId)
        await deps.router.bind(
          input.sessionId,
          input.deviceId,
          input.remoteRoot ?? null,
          input.mount ?? null,
          true,
        )
        const after = deps.router.assignmentForSession(input.sessionId)
        if (before?.deviceId !== after?.deviceId || before?.mount !== after?.mount) {
          await respawnShell(deps.ctx, input.sessionId)
        }
        return await state()
      }
      case 'install': {
        // Deploy BEFORE reading state. `state()` reads the device list, and the
        // install is what writes the status the card renders onto those
        // records, so evaluating it first would answer with the pre-install
        // list: the card would show nothing until some later call refreshed
        // it, which only happens on a reload.
        const helper = await deps.router.installHelper(input.deviceId)
        return { ...await state(), helper }
      }
      case 'listKeys': {
        // Answered without the device list: this is a property of the harness
        // user's home directory, and it is asked before any device exists.
        return { ...await state(), keys: await listLocalKeys() }
      }
      case 'readKey': {
        // A path the browser supplied, so the answer is decided entirely by
        // whether the host recognises it as one of the keys it just listed.
        const body = await readLocalKey(input.path)
        return {
          ...await state(),
          ...(body === undefined ? { error: deps.t('error.unknownKey') } : { keyBody: body }),
        }
      }
      case 'hostKeys': {
        const at = await deps.router.destinationOf(input.deviceId)
        if (at === undefined) return { ...await state(), error: deps.t('error.unknownDevice', { id: input.deviceId }) }
        return { ...await state(), hostKeys: await listTrustedHostKeys(at.host, at.port) }
      }
      case 'revokeHostKey': {
        const at = await deps.router.destinationOf(input.deviceId)
        if (at === undefined) return { ...await state(), error: deps.t('error.unknownDevice', { id: input.deviceId }) }
        // Read state AFTER, and re-read the keys rather than reporting what was
        // removed: the reply is what the card renders, so it must be the state
        // the file is actually in afterwards.
        await revokeTrustedHostKeys(at.host, at.port)
        return { ...await state(), hostKeys: await listTrustedHostKeys(at.host, at.port) }
      }
      case 'probeHostKey': {
        const at = await deps.router.destinationOf(input.deviceId)
        if (at === undefined) return { ...await state(), error: deps.t('error.unknownDevice', { id: input.deviceId }) }
        return { ...await state(), probe: await probeHostKey(at.host, at.port) }
      }
      case 'vaultList':
        return { ...await state(), ...await vaultFace(deps) }
      case 'vaultCreateGroup': {
        await deps.router.vault.createGroup(input.name, input.token)
        return { ...await state(), ...await vaultFace(deps) }
      }
      case 'vaultRenameGroup':
        await deps.router.vault.renameGroup(input.groupId, input.name)
        return { ...await state(), ...await vaultFace(deps) }
      case 'vaultDeleteGroup': {
        // Refused while anything still points into it. A credential whose group
        // vanished cannot be opened again, so deleting the group would silently
        // lock a device out rather than tidy a row away.
        const inside = (await deps.router.credentials.list()).filter(c => c.group === input.groupId)
        if (inside.length > 0) return { ...await state(), error: deps.t('error.groupNotEmpty') }
        await deps.router.vault.removeGroup(input.groupId)
        return { ...await state(), ...await vaultFace(deps) }
      }
      case 'vaultUnlock':
        // The refresh the lock skipped now has a key to build with: rebuild it
        // here, or a session bound to a device in this group would keep being
        // refused with the reason recorded while it was locked.
        await deps.router.unlockGroup(input.groupId, input.token)
        return { ...await state(), ...await vaultFace(deps) }
      case 'vaultLock':
        // Locking drops the key the plaintext was opened with, so the secret
        // cannot be read again — and the connections lose it with it, which the
        // router rebuilds.
        await deps.router.lockGroups(input.groupId)
        return { ...await state(), ...await vaultFace(deps) }
      case 'vaultSetToken':
        await deps.router.vault.setToken(input.groupId, input.token)
        await deps.router.credentials.rewrapGroup(input.groupId)
        return { ...await state(), ...await vaultFace(deps) }
      case 'vaultClearToken':
        await deps.router.vault.clearToken(input.groupId)
        await deps.router.credentials.rewrapGroup(input.groupId)
        return { ...await state(), ...await vaultFace(deps) }
      case 'credentialList':
        return { ...await state(), ...await vaultFace(deps) }
      case 'credentialSave': {
        try {
          await deps.router.credentials.save(input.credential)
        } catch (error) {
          return { ...await state(), error: error instanceof Error ? error.message : String(error) }
        }
        return { ...await state(), ...await vaultFace(deps) }
      }
      case 'credentialDelete': {
        // Same rule as the group: a device left pointing at a deleted credential
        // cannot log in, and finding out at connect time is the worst moment.
        const users = (await deps.router.list()).filter(device => device.credentialId === input.credentialId)
        if (users.length > 0) {
          return { ...await state(), error: deps.t('error.credentialInUse', { names: users.map(d => d.name).join('、') }) }
        }
        await deps.router.credentials.remove(input.credentialId)
        return { ...await state(), ...await vaultFace(deps) }
      }
      default:
        return { ...await state(), error: deps.t('error.unknownAction') }
    }
  }

  return {
    path: DSHELL_SSH_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        return respond(await handle(request))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        // A locked group is not a failure to report so much as a door to open.
        // The error names it; this carries the same name in a shape the panel
        // can act on, so a device test that lands on a locked credential opens
        // THAT group's unlock box rather than leaving the reader to hunt for it.
        const groupId = error instanceof VaultLockedError ? error.groupId : undefined
        const named = groupId === undefined ? undefined : await nameOf(deps, groupId)
        return respond({ ...await state(), error: reason, ...named === undefined ? {} : { lockedGroup: named } }, 400)
      }
    },
  }
}

/** The group a locked refusal names, as the panel needs to see it. */
async function nameOf(
  deps: SshRouteDeps,
  groupId: string,
): Promise<{ id: string; name: string } | undefined> {
  const group = (await deps.router.vault.list()).find(candidate => candidate.id === groupId)
  return group === undefined ? undefined : { id: group.id, name: group.name }
}
