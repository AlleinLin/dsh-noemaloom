import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { filesUnder, sourceIdentity } from './core.mjs';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node tools/acceptance/cognition-upstream.mjs --output <directory>');
const output = resolve(args[1]), repository = resolve('.'), originalVendor = resolve('vendor/memory-cognition');
const isolated = await mkdtemp(join(tmpdir(), 'noemaloom-cognition-'));
const vendor = join(isolated, 'package');
await mkdir(output, { recursive: true });
const source = await sourceIdentity(repository);
// Upstream regressions deliberately create package-relative synthetic stores.
// Execute identical copied bytes so those stores never enter source or delivery.
const copied = await filesUnder(originalVendor);
for (const path of copied) {
  const destination = join(vendor, relative(originalVendor, path));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(path, destination);
}
const modules = [
  'test_auto_defaults', 'test_c3_transient_read_negative', 'test_c8_search_rrf_gates',
  'test_exact_text_cache', 'test_issue274_read_node_id_none', 'test_issue561_pending_review',
  'test_p28_refcheck', 'test_p3_legacy_closure', 'test_p43_pooling', 'test_reach',
  'test_retr_gates_prodpath', 'test_sleep_p1', 'test_bm25_default', 'test_conflict_surface',
  'test_conflict_value_untrusted', 'test_conformance', 'test_domain_granularity',
  'test_hotcache_tool', 'test_index_snapshot_fastpath', 'test_issue578_service_info_gate',
  'test_issue623_fullwidth_symmetry', 'test_issue644_637_636', 'test_mr_m1',
  'test_reach_exits', 'test_reach_single_char', 'test_search_async',
  'test_search_bm25_default', 'test_search_prefilter', 'test_untrusted_audit',
  'test_untrusted_classifier', 'test_untrusted_enforcement',
  'test_issue218_postcondition_value_blind', 'test_issue650_658_f26',
  'test_issue659_r26_batch2', 'test_issue665_scrub_process_records',
  'test_issue669_ccg_empty_colon', 'test_issue672_validity_scope',
];
for (const name of ["test_b4_shard_dir_selfheal","test_b4_shard_dir_selfheal_guard","test_config_registry_silent_fallback","test_designer_token_coverage","test_i50e_readside_protection","test_issue452_ingest_root_sensitivity","test_issue659_r26_batch3","test_issue672_optional_assets","test_issue676_session_tasks_index_first","test_issue677_async_index_flush","test_issue677_dedupe_gate","test_issue678_narrowed_hint","test_mode_parity","test_mr_m2","test_n230_dirty_replay","test_protect_stats_parity","test_review_dual_check","test_time_core_lint","test_ui_wiring_in_repo","test_writegate_tiers","test_writepipe"]) if (!modules.includes(name)) modules.push(name);
for (const name of ["test_generation_guard", "test_i50c_meta_passthrough", "test_issue708_writegate_observable", "test_issue709_review_chain_enforce", "test_issue712_session_window_attribution", "test_p45_session_identity"]) if (!modules.includes(name)) modules.push(name);
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
  !/^(?:MDCG_|LINGSU_|LINGSHU_)/iu.test(name)
    && !/(?:TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION|CREDENTIAL)/iu.test(name)));
const env = { ...environment, PYTHONPATH: vendor, PYTHONDONTWRITEBYTECODE: '1',
  PYTHONUTF8: '1', OPENBLAS_NUM_THREADS: '1', MDCG_ROOT: join(isolated, 'root'),
  MDCG_AUX_ROOT: join(isolated, 'cognition-state'), MDCG_DATA_ROOT: join(isolated, 'cognition-state'),
  MDCG_INGEST_ROOT: isolated, MDCG_EXPORT_ROOT: isolated, MDCG_AUTO_BACKUP: '0',
  MDCG_MASTER_KEY_PATH: join(isolated, 'master.key'), MDCG_LINKS_FILE: join(isolated, 'links.json'),
  MDCG_SIGNERS_FILE: join(isolated, 'signers.json'), MDCG_SIGNER_KEY_FILE: join(isolated, 'signer.key'),
  MDCG_SWARM_DIR: join(isolated, 'swarm') };
// The unchanged upstream oracle exports HEAD. Give the clean isolated public
// copy its own synthetic baseline, before any test creates state. No hooks run.
const hooks = join(isolated, 'empty-hooks');
await mkdir(hooks);
async function git(args) {
  const child = spawn('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'core.autocrlf=false',
    '-c', 'user.name=Noemaloom isolated validation', '-c', 'user.email=validation@example.invalid',
    ...args], { cwd: vendor, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', bytes => { log += bytes; });
  child.stderr.on('data', bytes => { log += bytes; });
  const code = await new Promise((resolveGit, reject) => {
    child.once('error', reject); child.once('close', resolveGit);
  });
  if (code !== 0) throw new Error(`Isolated cognition Git baseline failed: ${log}`);
  return log.trim();
}
await git(['init', '--quiet']);
await git(['add', '--all']);
await git(['commit', '--quiet', '--no-gpg-sign', '-m', 'Public release validation baseline']);
const isolatedBaseline = await git(['rev-parse', 'HEAD']);
const report = { startedAt: new Date().toISOString(), sourceHash: source.sha256,
  copiedPublicSourceFiles: copied.length, usesIsolatedSourceCopy: true,
  isolatedSyntheticGitBaseline: isolatedBaseline, results: [], ok: false };
async function run(name, commandArgs) {
  const startedAt = new Date().toISOString();
  const child = spawn(process.env.NEXUS_PYTHON_EXECUTABLE ?? 'python', ['-X', 'utf8', ...commandArgs],
    { cwd: vendor, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); },
    name === 'test_time_core_lint' ? 600_000 : 180_000);
  child.stdout.on('data', bytes => { log += bytes; });
  child.stderr.on('data', bytes => { log += bytes; });
  const result = await new Promise(resolveRun => {
    child.once('error', error => resolveRun({ exitCode: 1, error: error.message }));
    child.once('close', (code, signal) => resolveRun({ exitCode: code ?? 1, signal }));
  });
  clearTimeout(timer);
  const path = join(output, `${name}.log`);
  await writeFile(path, log);
  const row = { name, startedAt, finishedAt: new Date().toISOString(), ...result, timedOut,
    // Upstream optional external baselines are never counted as passed checks.
    optionalSkipLines: log.split(/\r?\n/u).filter(line => /\bSKIP\b/u.test(line)), log: path };
  report.results.push(row);
  console.log(JSON.stringify({ name, exitCode: row.exitCode, timedOut, optionalSkips: row.optionalSkipLines.length }));
}
const compiler = join(output, 'compile.py');
await writeFile(compiler, `import pathlib, py_compile, tempfile
root = pathlib.Path(${JSON.stringify(vendor)})
files = sorted(root.rglob("*.py"))
assert files, "No Python sources discovered"
with tempfile.TemporaryDirectory(prefix="noemaloom-pyc-") as dest:
    for index, source in enumerate(files):
        py_compile.compile(str(source), cfile=str(pathlib.Path(dest) / (str(index) + ".pyc")), doraise=True)
print("Compiled", len(files), "Python source files")
`);
await run('compile-all', [compiler]);
for (const name of modules) {
  await readFile(join(vendor, 'md_cg', `${name}.py`)); // A missing selected regression is an error.
  await run(name, ['-m', `md_cg.${name}`]);
}
report.finishedAt = new Date().toISOString();
report.sourceUnchangedDuringRun = (await sourceIdentity(repository)).sha256 === source.sha256;
report.ok = report.results.every(row => row.exitCode === 0 && !row.timedOut) && report.sourceUnchangedDuringRun;
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
process.exitCode = report.ok ? 0 : 1;
