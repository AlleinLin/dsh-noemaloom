import { parseDocument } from 'yaml';

/** The reviewed 0.5.2 bundle owns one row; retain its switches and defaults. */
export function configureOpsComposition(source) {
  const document = parseDocument(source);
  if (document.errors.length) throw new Error('Invalid dsh-ops composition');
  const data = document.toJS();
  if (data.length !== 1 || data[0].insert?.length !== 1
    || data[0].insert[0].id !== 'dsh-ops' || data[0].insert[0].name !== 'dsh-ops')
    throw new Error('Reviewed dsh-ops merged row changed');
  for (const feature of ['ptc', 'discovery']) {
    const path = [0, 'insert', 0, 'config', feature];
    if (document.getIn([...path, 'enabled']) !== true)
      throw new Error(`Missing dsh-ops enabled setting: ${feature}`);
    if (document.hasIn([...path, 'alwaysLoaded']))
      throw new Error(`Upstream dsh-ops now owns alwaysLoaded: ${feature}; review before replacing`);
    document.setIn([...path, 'alwaysLoaded'], ['grep', 'glob']);
  }
  return document.toString();
}
