/** Small, reviewed adaptations over immutable upstream sources. */
export const COMPUTER_USE_API = '/api/plugins/dsh-noemaloom/computer-use';
export const originalThemeCss = `
.dgui-root.dgui-root{--du-accent:var(--dsw-alias-brand-primary,#c66a4a);--du-tint:color-mix(in srgb,var(--du-accent) 9%,var(--du-bg));border-radius:18px}
body[data-ds-dark-theme] .dgui-root.dgui-root,.dgui-root.dgui-root[data-preview-theme=dark]{--du-accent:#e6a286}
.dsh-cu-chip.dsh-cu-chip{border-radius:12px}
.dsh-cu-chip[data-state=on]{color:var(--dsw-alias-brand-primary,#c66a4a)}
@media(prefers-reduced-motion:reduce){.dgui-root *,.dgui-root *::before,.dgui-root *::after,.dsh-cu-chip,.dsh-cu-chip *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`;

function once(source, anchor, replacement, label) {
  const offset = source.indexOf(anchor);
  if (offset < 0 || source.indexOf(anchor, offset + anchor.length) !== -1) {
    throw new Error(`${label}: upstream anchor changed; review the new revision before adapting`);
  }
  return source.slice(0, offset) + replacement + source.slice(offset + anchor.length);
}

export function adaptMotionClient(factory) {
  // Reviewed 0.8.8 keeps this complete original CSS assembly and media pipeline.
  return once(factory, 'style.textContent = CSS2 + VISUAL_CSS + MEDIA_PLAYER_CSS;',
    `style.textContent = CSS2 + VISUAL_CSS + MEDIA_PLAYER_CSS + ${JSON.stringify(originalThemeCss)};`,
    'Motion UI native Claude appearance');
}

export function adaptComputerUseClient(factory) {
  let source = once(factory, "const ROUTE = '/computer-use';",
    `const ROUTE = ${JSON.stringify(COMPUTER_USE_API)};`, 'Computer-use authenticated API');
  source = once(source, 'style.textContent = CSS;',
    `style.textContent = CSS + ${JSON.stringify(originalThemeCss)};`, 'Computer-use native Claude appearance');
  return once(source, 'document.head.appendChild(style);',
    'document.head.appendChild(style);\n          ctx.effect(() => () => style.remove(), "computer-use: chip styles");',
    'Computer-use native client style cleanup');
}

export function adaptComputerUseHost(source) {
  let adapted = once(source, "export const inject = bootstrapError === null ? ['tools'] : [];",
    "export const inject = bootstrapError === null ? ['tools', 'connection'] : ['connection'];",
    'Computer-use owner authenticated carrier including degraded diagnostics');
  adapted = once(adapted, "ctx.inject(['webServer'], (scoped) => {",
    "ctx.inject(['connection'], (scoped) => {\n    const webServer = authenticatedComputerUseRoutes(scoped);",
    'Computer-use carrier registration');
  const anchor = 'scoped.webServer.register({';
  if (adapted.split(anchor).length !== 5) throw new Error('Computer-use expected four reviewed native JSON routes');
  adapted = adapted.replaceAll(anchor, 'webServer.register({');
  return "import { authenticatedComputerUseRoutes } from './internal/nexus-auth-routes.mjs';\n" + adapted;
}

export function adaptComputerUseDegraded(source) {
  let adapted = once(source, "ctx?.inject?.(['webServer'], (scoped) => {",
    "ctx?.inject?.(['connection'], (scoped) => {\n      const webServer = authenticatedComputerUseRoutes(scoped);",
    'Computer-use authenticated degraded diagnostics');
  const anchor = 'scoped.webServer.register({';
  if (adapted.split(anchor).length !== 3) throw new Error('Computer-use expected two degraded diagnostic routes');
  adapted = adapted.replaceAll(anchor, 'webServer.register({');
  return "import { authenticatedComputerUseRoutes } from './nexus-auth-routes.mjs';\n" + adapted;
}
