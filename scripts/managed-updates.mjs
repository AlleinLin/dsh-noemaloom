import ts from 'typescript';

// These names and anchors are reviewed against the exact versions in
// originals-manifest.ts. Adapt build output only; never edit installed npm files.
export function suppressManagedUpdateUi(packageName, source) {
  const rules = {
    'dsh-context': [
      ['fc', 'uc().then', 'function fc(){return null}'],
      ['lc', '/dsh-context/latest', 'function lc(){return Promise.resolve(null)}'],
    ],
    'dsh-mnemon': [
      ['VersionDialog', 'versions', 'function VersionDialog(){return null}'],
    ],
    '@michengai/dsh-agency-agents': [
      ['wc', 'updateAvailable', 'function wc(){return null}'],
      ['Tc', 'Sc(e.endpoint', 'function Tc(){return()=>{}}'],
    ],
  }[packageName];
  if (!rules) return { source, changes: [] };
  const ast = ts.createSourceFile('original-client.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const edits = [];
  function visit(node) {
    if (ts.isFunctionDeclaration(node)) {
      const rule = rules.find(([name]) => node.name?.text === name);
      if (rule) {
        if (!node.getText(ast).includes(rule[1])) throw new Error(`${packageName}: managed updater anchor changed (${rule[0]})`);
        edits.push({ start: node.getStart(ast), end: node.end, text: rule[2], name: rule[0] });
      }
    }
    if (packageName === 'dsh-mnemon' && ts.isPropertyAssignment(node)
      && node.name.getText(ast) === 'action' && node.initializer.getText(ast).includes('t("versions.checkAction")')) {
      edits.push({ start: node.initializer.getStart(ast), end: node.initializer.end, text: 'undefined', name: 'version-action' });
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (edits.length !== rules.length + Number(packageName === 'dsh-mnemon')) throw new Error(`${packageName}: expected unique managed updater boundaries`);
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  return { source, changes: ['central-weekly-upstream-maintenance-without-independent-update-ui'] };
}
