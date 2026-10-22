const alwaysLoaded = new Map([
  ['dsh-ops-ptc', ['grep', 'glob']],
  ['dsh-ops-discovery', ['grep', 'glob']],
]);

export function configureOpsComposition(source) {
  const lines = source.split(/(?<=\n)/);
  const found = new Set();
  let currentRow;

  for (let index = 0; index < lines.length; index++) {
    const row = lines[index].match(/^[ \t]*- id:\s*(\S+)\s*(?:#.*)?(?:\r?\n)?$/);
    if (row) {
      currentRow = alwaysLoaded.has(row[1]) ? row[1] : undefined;
      continue;
    }

    if (!currentRow) continue;
    const setting = lines[index].match(/^([ \t]*alwaysLoaded:\s*)(\[[^\]\r\n]*\])([ \t]*(?:#.*)?)(\r?\n)?$/);
    if (!setting) continue;
    if (found.has(currentRow)) throw new Error(`Duplicate dsh-ops alwaysLoaded setting: ${currentRow}`);
    lines[index] = `${setting[1]}[${alwaysLoaded.get(currentRow).join(', ')}]${setting[3]}${setting[4] ?? ''}`;
    found.add(currentRow);
  }

  for (const id of alwaysLoaded.keys()) {
    if (!found.has(id)) throw new Error(`Missing dsh-ops alwaysLoaded setting: ${id}`);
  }

  return lines.join('');
}
