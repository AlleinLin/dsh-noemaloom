/**
 * Literal-edit and line-ending rules, mirrored from the local filesystem
 * backend.
 *
 * The remote backend applies edits to text it read over SSH, so it cannot call
 * `dsh-fs-local`'s own helpers: that package exposes them only through its
 * source subpath, which a build that emits JavaScript cannot import. The rules
 * are duplicated here instead of approximated, and they must stay in step with
 * `@deepseek-ai/dsh-fs-local/src/fsio.ts` — the symbols mirrored are
 * `applyLiteralEdit`, `countOccurrences`, `normalizeLineEndings`,
 * `detectLineEndings` and `restoreLineEndings`.
 *
 * Behaviour that matters and is easy to get subtly wrong, hence the copy:
 * an empty or missing `oldString` is `FS_EDIT_NOT_FOUND`, more than one match
 * is `FS_AMBIGUOUS_EDIT` unless `replaceAll`, matching happens against
 * LF-normalized text, and write-back restores the style the file had.
 */

import { FsError } from '@deepseek-ai/dsh-fs'

/** Line ending style detected before LF normalization. */
export type LineEndings = 'LF' | 'CRLF'

/** Collapse CRLF to LF — the canonical in-memory form every edit/diff basis uses. */
export function normalizeLineEndings(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

/** Detect a file's dominant line ending from its first 4 KiB. */
export function detectLineEndings(raw: string): LineEndings {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1 - crlfCount
  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/** Convert LF-normalized content back to the style detected at read time. */
export function restoreLineEndings(content: string, lineEndings: LineEndings): string {
  return lineEndings === 'LF' ? content : normalizeLineEndings(content).split('\n').join('\r\n')
}

/** Count non-overlapping occurrences of `needle`. */
function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  while (true) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * Apply a literal replacement to LF-normalized content.
 * @param content - current content, already LF-normalized.
 * @param oldString - literal text to find; CRLF inside it is normalized first.
 * @param newString - literal replacement, normalized the same way.
 * @param replaceAll - replace every match instead of requiring exactly one.
 * @param displayPath - caller-facing path used in error messages.
 * @returns the edited LF-normalized content.
 */
export function applyLiteralEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
  displayPath: string,
): { content: string; replacements: number } {
  const oldNorm = normalizeLineEndings(oldString)
  if (oldNorm.length === 0) {
    throw new FsError('old_string must be a non-empty string', 'FS_EDIT_NOT_FOUND')
  }
  const newNorm = normalizeLineEndings(newString)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) {
    throw new FsError(`old_string was not found in "${displayPath}"`, 'FS_EDIT_NOT_FOUND')
  }
  if (!replaceAll && replacements > 1) {
    throw new FsError(
      `old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`,
      'FS_AMBIGUOUS_EDIT',
    )
  }
  return { content: content.split(oldNorm).join(newNorm), replacements }
}
