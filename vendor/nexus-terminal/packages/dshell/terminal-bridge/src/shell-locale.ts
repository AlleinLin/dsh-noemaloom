/**
 * The locale a spawned shell runs under.
 *
 * The shell's environment is inherited from whatever launched the harness —
 * a desktop session, a container runtime, an agent sandbox — and the value it
 * carries is not always one a terminal can render with. Two readers disagree
 * about the same name:
 *
 *  - glibc resolves `C.UTF-8` to a real UTF-8 locale, so programs that ask it
 *    are fine.
 *  - uutils coreutils (Ubuntu 25.10's `rust-coreutils`, which ships `/bin/ls`)
 *    decides its quoting from the locale NAME and treats every `C`/`POSIX`
 *    family name — `C.UTF-8` included — as ASCII. Its `ls` on a terminal then
 *    shell-escapes every non-ASCII byte of a filename: a directory holding
 *    `文档` lists it as `''$'\346\226\207\346\241\243'`. `LC_CTYPE` is not read
 *    at all, and `LANG` is, so a lone `LC_CTYPE=zh_CN.UTF-8` leaves bash in
 *    UTF-8 while `ls` still escapes.
 *
 * The ambient value is kept whenever it already names a real UTF-8 locale.
 * Otherwise the shell is given one: a real UTF-8 locale the environment
 * already names (an `LANG` shadowed by `LC_ALL=C.UTF-8` is the common case —
 * agent sandboxes set exactly that), else one the machine actually has.
 * `locale -a` is the only honest answer to "what exists here", so it is probed
 * once per process and cached; a missing binary or an empty answer leaves the
 * ambient value untouched rather than inventing one.
 */

import { execFile } from 'node:child_process'

/** The locale variables a shell resolves, in the order bash resolves them. */
export interface ShellLocaleAmbient {
  readonly LC_ALL?: string | undefined
  readonly LC_CTYPE?: string | undefined
  readonly LANG?: string | undefined
}

/** How long the one-time `locale -a` probe may take. */
const PROBE_TIMEOUT_MS = 5000

/**
 * Whether a locale name belongs to the portable C family.
 *
 * `C`, `POSIX`, `C.UTF-8` and `C.utf8` all do: the language part is the whole
 * name, and every program reads them as "no locale".
 * @param name - a locale name, e.g. `zh_CN.UTF-8`.
 * @returns whether the name is in the C/POSIX family.
 */
export function isCFamilyLocale(name: string): boolean {
  const language = languageOf(name)
  return language === '' || language === 'c' || language === 'posix'
}

/**
 * Whether a locale name asks for a UTF-8 codeset.
 *
 * Name-based on purpose: that is what uutils checks, and a locale that names
 * UTF-8 is treated as UTF-8 by every reader whether or not the machine has
 * it installed (an uninstalled name costs messages, never the charset).
 * @param name - a locale name, e.g. `zh_CN.UTF-8`.
 * @returns whether the codeset part says UTF-8.
 */
export function isUtf8LocaleName(name: string): boolean {
  const codeset = name.split('.')[1]?.toLowerCase()
  return codeset === 'utf-8' || codeset === 'utf8'
}

/** The language part of a locale name, lowercased (`zh_CN.UTF-8` → `zh`). */
function languageOf(name: string): string {
  return name.split(/[._@]/)[0]?.toLowerCase() ?? ''
}

/**
 * The `LC_ALL` value the shell should run under, or undefined to leave the
 * ambient environment exactly as it is.
 *
 * @param ambient - the locale variables the spawning process carries.
 * @param available - locale names the machine has, e.g. `locale -a` output.
 * @returns the locale to set as `LC_ALL`, or undefined for no change.
 */
export function resolveShellLocale(
  ambient: ShellLocaleAmbient,
  available: readonly string[],
): string | undefined {
  // What the shell itself resolves (LC_ALL → LC_CTYPE → LANG), and what a
  // name-checking program resolves (LC_ALL → LANG, LC_CTYPE never).
  const effective = ambient.LC_ALL ?? ambient.LC_CTYPE ?? ambient.LANG ?? ''
  const named = ambient.LC_ALL ?? ambient.LANG ?? ''
  // Already good: every reader sees a real UTF-8 locale.
  if (isUtf8LocaleName(effective) && !isCFamilyLocale(effective)
    && isUtf8LocaleName(named) && !isCFamilyLocale(named)) return undefined
  // A non-C locale that is not UTF-8 (ISO-8859-1, EUC-JP …) is a deliberate
  // choice, not a fault; a terminal must not override it.
  if (!isCFamilyLocale(effective) && !isUtf8LocaleName(effective)) return undefined
  // The ambient is C-family (C, POSIX, C.UTF-8, or nothing at all), or the
  // shell and the name-checking programs disagree about a UTF-8 LC_CTYPE. A
  // real UTF-8 locale the environment already names is the best replacement:
  // it is the one the user picked, merely shadowed.
  const wanted = [ambient.LC_CTYPE, ambient.LANG].filter(
    (name): name is string => name !== undefined && !isCFamilyLocale(name) && isUtf8LocaleName(name),
  )
  const utf8 = available.filter(name => !isCFamilyLocale(name) && isUtf8LocaleName(name))
  // 1. The installed spelling of a locale the environment names: `locale -a`
  //    says what actually loads, and an uninstalled name costs glibc its
  //    locale even where a name-checking program would accept it.
  for (const name of wanted) {
    const installed = utf8.find(candidate => sameLocale(candidate, name))
    if (installed !== undefined) return installed
  }
  // 2. One the machine has, preferring the ambient language so a Japanese
  //    session does not end up printing Chinese program messages.
  const language = languageOf(ambient.LANG ?? ambient.LC_CTYPE ?? '')
  const found = (language === '' ? undefined : utf8.find(name => languageOf(name) === language)) ?? utf8[0]
  if (found !== undefined) return found
  // 3. Nothing installed to choose from: the ambient's own spelling, which a
  //    name-checker still reads as UTF-8 (this is also the failed-probe path).
  const named0 = wanted[0]
  if (named0 !== undefined) return named0
  // 4. Nothing better exists. `C.UTF-8` is the best a name-checker can read,
  //    so it is kept when that is what the ambient already is; a bare C/POSIX
  //    ambient is left alone too, because nothing here can improve on it.
  return isUtf8LocaleName(effective) ? effective : undefined
}

/** Whether two locale names name the same locale, spellings aside. */
function sameLocale(left: string, right: string): boolean {
  return normalizeLocale(left) === normalizeLocale(right)
}

/** The comparable form of a locale name: lowercased, codeset dashes dropped. */
function normalizeLocale(name: string): string {
  const [language, codeset] = name.split('.')
  return codeset === undefined ? name.toLowerCase() : `${language.toLowerCase()}.${codeset.toLowerCase().replaceAll('-', '')}`
}

/** The cached `locale -a` answer; the machine's locale set does not change. */
let availableProbe: Promise<readonly string[]> | undefined

/** The cached resolution; one harness process spawns one kind of shell. */
let resolved: Promise<string | undefined> | undefined

/**
 * The locale names this machine has, probed once.
 *
 * @returns the names, or an empty list when `locale` is missing or slow.
 */
function availableLocales(): Promise<readonly string[]> {
  availableProbe ??= new Promise(resolve => {
    execFile('locale', ['-a'], { timeout: PROBE_TIMEOUT_MS }, (error, stdout) => {
      resolve(error === null
        ? stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
        : [])
    })
  })
  return availableProbe
}

/**
 * The `LC_ALL` every shell this backend spawns should run under.
 *
 * Resolved once per process: the ambient environment and the machine's locale
 * set are both fixed for a harness run, and the first PTY spawn pays the one
 * probe.
 * @returns the locale to set as `LC_ALL`, or undefined for no change.
 */
export function shellLocale(): Promise<string | undefined> {
  resolved ??= (async () => resolveShellLocale({
    LC_ALL: process.env.LC_ALL,
    LC_CTYPE: process.env.LC_CTYPE,
    LANG: process.env.LANG,
  }, await availableLocales()))()
  return resolved
}
