/**
 * dshell's delta from upstream's electron-builder config for the Linux desktop
 * build: the icon upstream never sets, and the installer targets dshell ships.
 *
 * **The icon.** Upstream ships no application icon at all — no `icon` field in
 * its config, no asset under `apps/desktop` — so every build before 2026-09-15
 * carried the default Electron atom. It is a directory rather than one file on
 * purpose: electron-builder reads a directory's `NxN.png` names as the sizes
 * themselves and does not re-measure or re-resample them (`collectIconsFromDir`
 * in `app-builder-lib`). Each name becomes a `hicolor/NxN/apps/` entry and the
 * largest also becomes the `.desktop` entry's icon, so a file whose name
 * disagrees with its pixels lands a blurred icon with nothing to report it.
 * `scripts/tests/linux-desktop.spec.ts` checks that agreement.
 *
 * The mark is dshell's own, drawn for this purpose and not taken from upstream:
 * the prompt (chevron and block cursor) is the shell, the spark beside it is the
 * agent. `assets/icons/*.svg` are the sources; see docs/dshell-setup.md for the
 * regeneration command.
 *
 * **The targets.** Upstream builds mac and win only; `AppImage` was its own Linux
 * target and `deb` is added here, so the app can be installed rather than only
 * run from a portable file. fpm refuses to build a `.deb` without `maintainer`
 * and a project URL, and neither upstream's `package.json` nor ours carries
 * either — the maintainer is the checkout's own git identity, since this build
 * never leaves the machine, and the URL goes in through `extraMetadata` because
 * electron-builder's config has no field of its own for `homepage`.
 *
 * Applying the delta lives here rather than in the config file so it can be
 * tested — importing upstream's config means resolving a desktop target, which
 * throws for linux-x64 outside the packaging loader.
 */

import { fileURLToPath } from 'node:url'

/** Absolute path, so it resolves the same from electron-builder's cwd. */
export const LINUX_ICON_DIR = fileURLToPath(new URL('../assets/icons/linux', import.meta.url))

/** The sizes the directory is expected to hold, smallest first. */
export const LINUX_ICON_SIZES = [16, 32, 48, 64, 128, 256, 512]

/** Linux artifacts to build: the portable image, and the installable package. */
export const LINUX_TARGETS = ['AppImage', 'deb']

/** Required by fpm; the checkout's own identity, since releases stop at this disk. */
export const DEB_MAINTAINER = 'dshell maintainers <maintainers@nexus-aethra.dev>'

/** Required by fpm when the package metadata carries none of its own. */
export const HOMEPAGE = 'https://github.com/Nexus-Aethra/Nexus-Terminal'

/**
 * Upstream's config with the Linux icon and targets added, everything else left
 * alone.
 * @param config - A config from upstream's `createElectronBuilderConfig`.
 * @returns A copy carrying `linux.icon`, `linux.target`, `deb.maintainer`, and a
 * homepage in the packaged metadata when upstream has none.
 */
export function withLinuxDesktop(config) {
  const extraMetadata = { ...config.extraMetadata }
  // fpm wants a project URL and reads it from the package metadata, where
  // electron-builder has no config field of its own for it.
  extraMetadata.homepage ??= HOMEPAGE
  return {
    ...config,
    extraMetadata,
    linux: { ...config.linux, icon: LINUX_ICON_DIR, target: [...LINUX_TARGETS] },
    deb: { ...config.deb, maintainer: DEB_MAINTAINER },
  }
}
