import { describe, expect, it } from 'vitest'
import { isCFamilyLocale, isUtf8LocaleName, resolveShellLocale } from '../src/shell-locale.js'

/** `locale -a` on a machine whose archive holds two CJK locales. */
const MACHINE = ['C', 'C.utf8', 'POSIX', 'zh_CN.utf8', 'zh_SG.utf8'] as const

describe('locale name readers', () => {
  it('reads the C family by its language part, codeset included', () => {
    expect(isCFamilyLocale('C')).toBe(true)
    expect(isCFamilyLocale('POSIX')).toBe(true)
    expect(isCFamilyLocale('C.UTF-8')).toBe(true)
    expect(isCFamilyLocale('c.utf8')).toBe(true)
    expect(isCFamilyLocale('POSIX.UTF-8')).toBe(true)
    expect(isCFamilyLocale('zh_CN.UTF-8')).toBe(false)
    expect(isCFamilyLocale('')).toBe(true)
  })

  it('reads a UTF-8 codeset in either spelling', () => {
    expect(isUtf8LocaleName('zh_CN.UTF-8')).toBe(true)
    expect(isUtf8LocaleName('zh_CN.utf8')).toBe(true)
    expect(isUtf8LocaleName('en_US.ISO-8859-1')).toBe(false)
    expect(isUtf8LocaleName('C.UTF-8')).toBe(true)
    expect(isUtf8LocaleName('zh_CN')).toBe(false)
  })
})

describe('resolveShellLocale', () => {
  it('leaves an ambient locale every reader already sees as UTF-8', () => {
    expect(resolveShellLocale({ LC_ALL: 'en_US.UTF-8' }, MACHINE)).toBeUndefined()
    expect(resolveShellLocale({ LANG: 'zh_CN.UTF-8' }, MACHINE)).toBeUndefined()
    expect(resolveShellLocale({ LC_ALL: 'en_US.UTF-8', LANG: 'zh_CN.UTF-8' }, MACHINE)).toBeUndefined()
  })

  it('leaves a deliberate non-UTF-8 locale alone', () => {
    expect(resolveShellLocale({ LC_ALL: 'en_US.ISO-8859-1' }, MACHINE)).toBeUndefined()
    expect(resolveShellLocale({ LANG: 'ja_JP.eucJP' }, MACHINE)).toBeUndefined()
  })

  it('replaces a C-family LC_ALL with the installed spelling of the real locale', () => {
    // The sandbox case: an agent harness exports LC_ALL=C.UTF-8 over a real
    // LANG, and uutils' ls reads the C-family name as ASCII.
    expect(resolveShellLocale({ LC_ALL: 'C.UTF-8', LANG: 'zh_CN.UTF-8' }, MACHINE)).toBe('zh_CN.utf8')
    expect(resolveShellLocale({ LC_ALL: 'C', LANG: 'zh_CN.UTF-8' }, MACHINE)).toBe('zh_CN.utf8')
    // A failed probe still yields the ambient spelling, which a name-checker
    // reads as UTF-8 even where glibc cannot load it.
    expect(resolveShellLocale({ LC_ALL: 'C.UTF-8', LANG: 'zh_CN.UTF-8' }, [])).toBe('zh_CN.UTF-8')
  })

  it('aligns a lone LC_CTYPE into LC_ALL for name-checking programs', () => {
    // bash resolves LC_CTYPE, uutils never reads it: without LC_ALL the two
    // disagree about the charset of the same terminal.
    expect(resolveShellLocale({ LC_CTYPE: 'zh_CN.UTF-8' }, MACHINE)).toBe('zh_CN.utf8')
    expect(resolveShellLocale({ LC_CTYPE: 'zh_CN.UTF-8' }, [])).toBe('zh_CN.UTF-8')
  })

  it('falls back to a locale the machine has, preferring the ambient language', () => {
    expect(resolveShellLocale({ LC_ALL: 'C.UTF-8' }, MACHINE)).toBe('zh_CN.utf8')
    expect(resolveShellLocale({ LC_ALL: 'C' }, MACHINE)).toBe('zh_CN.utf8')
    expect(resolveShellLocale({}, MACHINE)).toBe('zh_CN.utf8')
    expect(resolveShellLocale({ LC_ALL: 'C', LANG: 'ja_JP.UTF-8' }, ['en_US.utf8', 'ja_JP.utf8'])).toBe('ja_JP.utf8')
    // The wanted language is not installed: any UTF-8 locale beats C.
    expect(resolveShellLocale({ LC_ALL: 'C', LANG: 'ja_JP.UTF-8' }, MACHINE)).toBe('zh_CN.utf8')
  })

  it('keeps C.UTF-8 when the machine has nothing better, and C when it has nothing at all', () => {
    expect(resolveShellLocale({ LC_ALL: 'C.UTF-8' }, ['C', 'C.utf8', 'POSIX'])).toBe('C.UTF-8')
    expect(resolveShellLocale({ LC_ALL: 'C' }, ['C', 'C.utf8', 'POSIX'])).toBeUndefined()
    expect(resolveShellLocale({}, [])).toBeUndefined()
  })

  it('never picks a C-family entry out of the available list', () => {
    expect(resolveShellLocale({ LC_ALL: 'C' }, ['C', 'POSIX', 'C.utf8'])).toBeUndefined()
    expect(resolveShellLocale({ LC_ALL: 'C' }, ['C.utf8', 'en_US.utf8'])).toBe('en_US.utf8')
  })
})
