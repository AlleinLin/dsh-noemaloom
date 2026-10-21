import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from 'react/jsx-runtime';
import { translate } from './i18n.js';
export { Fragment };
function localized(props: any) {
  if (!props || props['data-nexus-verbatim'] !== undefined) return props;
  const next = { ...props };
  const text = (value: any): any => typeof value === 'string' ? translate(value) : Array.isArray(value) ? value.map(text) : value;
  next.children = text(props.children);
  for (const key of ['placeholder', 'title', 'aria-label']) if (typeof props[key] === 'string') next[key] = translate(props[key]);
  return next;
}
export function jsx(type: any, props: any, key?: any) { return reactJsx(type, localized(props), key); }
export function jsxs(type: any, props: any, key?: any) { return reactJsxs(type, localized(props), key); }
