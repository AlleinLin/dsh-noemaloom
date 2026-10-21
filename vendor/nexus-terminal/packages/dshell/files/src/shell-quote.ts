/**
 * One shell argument, safely: single quotes, closed and reopened around each
 * quote in the value.
 *
 * The rule every command line this package builds has to obey — the `cd` the
 * navigator feeds the terminal, the `mkdir`/`split`/`sha256sum` the transfer
 * runs, and the completion oracle below. It was written twice (copy for copy)
 * before the oracle needed it a third time, which is when a value that must not
 * be re-read as syntax stops being a detail of whichever file happens to need it.
 *
 * @param value - the argument, as data.
 * @returns the argument as one shell word.
 */
export function quote(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}
