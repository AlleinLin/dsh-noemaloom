import { appendFile, readFile } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';

const log = await readFile('evidence/tests.stdout.log', 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return '';
});
const text = stripVTControlCharacters(log);
const failedSection = text.lastIndexOf('failing tests:');
const details = (failedSection >= 0 ? text.slice(failedSection) : text.split('\n').slice(-180).join('\n'))
  .slice(-24000).trim() || 'The check failed before test output was written; inspect the build or typecheck step.';
const escaped = details.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
console.log(`::error title=Automated check failure details::${escaped}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `## Automated check failure details\n\n<pre>${details.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>\n`);
}
