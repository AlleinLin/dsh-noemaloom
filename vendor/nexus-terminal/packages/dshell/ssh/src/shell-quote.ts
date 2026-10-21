/**
 * Words that go into a remote shell line.
 *
 * The transport carries a command as one string the device's login shell reads,
 * so anything the caller or the device record contributes to that string has to
 * be quoted for a POSIX shell. One function, because a second quoting
 * implementation is a second chance to be wrong about a filename.
 */

/**
 * One DEVICE path, as the device's own shell reads it.
 *
 * A `~` root is expanded by the DEVICE, not here: the host does not know the
 * device's home directory unless a helper has reported it, and the device's
 * shell does know. So the tilde stays OUTSIDE the quotes — `~/'my file'` —
 * because inside them it would name a file called `~`, and the device would
 * answer "No such file or directory" about a directory that is really there.
 *
 * Every command in this package is read by the device's login shell, so this is
 * the one place that has to know the difference.
 *
 * @param path - a path in the device's namespace.
 * @returns the word the device's shell reads.
 */
export function quoteDevicePath(path: string): string {
  if (path === '~') return '~'
  if (!path.startsWith('~/')) return quote(path)
  return `~/${quote(path.slice(2))}`
}

/** Quote one word for a POSIX shell. */
export function quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`
}
