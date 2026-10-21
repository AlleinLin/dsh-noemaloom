import { createHash } from 'node:crypto';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const canaryPattern = /^nexus-e2e-[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const errorNames = new Set([
  'Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError', 'EvalError',
  'URIError', 'AggregateError', 'AbortError', 'TimeoutError', 'SecurityError',
  'NetworkError', 'NotFoundError', 'InvalidStateError', 'DOMException', 'NexusError',
]);
const errorCodes = new Set([
  'INVALID_ARGUMENT', 'NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_CONFLICT',
  'PERMISSION_REQUIRED', 'PERMISSION_DENIED', 'DEPENDENCY_MISSING', 'HOST_CONTRACT_UNSUPPORTED',
  'STALE_PLAN', 'BUDGET_EXCEEDED', 'RATE_LIMITED', 'UPSTREAM_UNAVAILABLE', 'PARTIAL_EFFECT',
  'INTEGRITY_FAILED', 'RESYNC_REQUIRED', 'CANCELLED', 'INTERNAL',
  'APPROVAL_REQUIRED', 'REVISION_REQUIRED', 'EXTERNAL_CHANGE', 'SECRET_REJECTED',
  'EVIDENCE_REQUIRED', 'INDEPENDENT_REVIEW_REQUIRED', 'INVALID_ID', 'REPAIR_REQUIRED',
  'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'nexus/bad-request', 'invalid-envelope',
]);

function invalid(message) {
  throw new TypeError(message);
}

export function validateDesktopProjectionOptions(options) {
  if (!plain(options)) invalid('Desktop projection requires explicit identity options');
  for (const key of ['packageSha256', 'sourceHash']) {
    if (typeof options[key] !== 'string' || !/^[a-f0-9]{64}$/iu.test(options[key]))
      invalid('Desktop projection requires SHA256 identity options');
  }
  if (typeof options.memoryId !== 'string' || !canaryPattern.test(options.memoryId))
    invalid('Memory selection must be an exact nexus-e2e canary id');
  const hasGraphId = options.graphId !== undefined;
  const hasGraphTitle = options.graphTitle !== undefined;
  if (hasGraphId !== hasGraphTitle
    || hasGraphId && (typeof options.graphId !== 'string'
      || !canaryPattern.test(options.graphId) && !uuidPattern.test(options.graphId)
      || typeof options.graphTitle !== 'string' || !canaryPattern.test(options.graphTitle)))
    invalid('Graph selection requires an exact canary id or UUID and a nexus-e2e canary title');
  return {
    packageSha256: options.packageSha256.toLowerCase(),
    sourceHash: options.sourceHash.toLowerCase(),
    memoryId: options.memoryId,
    ...(hasGraphId ? { graphId: options.graphId, graphTitle: options.graphTitle } : {}),
  };
}

export function parseDesktopProjectionArguments(args) {
  const names = new Map([
    ['--input', 'input'], ['--output', 'output'], ['--package-sha256', 'packageSha256'],
    ['--source-hash', 'sourceHash'], ['--memory-id', 'memoryId'],
    ['--graph-id', 'graphId'], ['--graph-title', 'graphTitle'],
  ]);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = names.get(args[index]);
    const value = args[index + 1];
    if (!name || Object.hasOwn(values, name) || typeof value !== 'string'
      || !value || value.startsWith('--')) invalid('Invalid desktop projection arguments');
    values[name] = value;
  }
  if (!values.input || !values.output) invalid('Desktop projection requires input and output paths');
  return { input: values.input, output: values.output, ...validateDesktopProjectionOptions(values) };
}

function boolean(target, source, key) {
  if (plain(source) && typeof source[key] === 'boolean') target[key] = source[key];
}

function integer(target, source, key) {
  if (plain(source) && Number.isSafeInteger(source[key]) && source[key] >= 0)
    target[key] = source[key];
}

function choice(target, source, key, values) {
  if (plain(source) && values.includes(source[key])) target[key] = source[key];
}

function hashText(value) {
  // length counts the actual returned string's UTF-16 code units; sha256 hashes UTF-8.
  return { sha256: digest(value), length: value.length, utf8Bytes: Buffer.byteLength(value, 'utf8') };
}

function projectError(value) {
  const projected = {};
  if (typeof value === 'string' && errorCodes.has(value)) projected.code = value;
  if (plain(value)) {
    if (errorCodes.has(value.code)) projected.code = value.code;
    if (errorNames.has(value.name)) projected.name = value.name;
  }
  return Object.keys(projected).length ? projected : undefined;
}

function runtimeFacts(value) {
  if (!plain(value)) return undefined;
  const result = {};
  if (typeof value.node === 'string' && /^v\d+\.\d+\.\d+$/u.test(value.node)) result.node = value.node;
  for (const key of ['modules', 'napi'])
    if (typeof value[key] === 'string' && /^\d{1,8}$/u.test(value[key])) result[key] = value[key];
  choice(result, value, 'platform', ['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32']);
  choice(result, value, 'arch', ['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64']);
  return Object.keys(result).length ? result : undefined;
}

function storageFacts(value) {
  if (!plain(value)) return undefined;
  const result = {};
  choice(result, value, 'backend', ['node:sqlite-worker', 'uninitialized']);
  if (typeof value.sqlite === 'string' && /^\d+\.\d+\.\d+$/u.test(value.sqlite)) result.sqlite = value.sqlite;
  integer(result, value, 'userVersion');
  choice(result, value, 'synchronous', ['OFF', 'NORMAL', 'FULL', 'EXTRA', 0, 1, 2, 3]);
  choice(result, value, 'journalMode', ['DELETE', 'TRUNCATE', 'PERSIST', 'MEMORY', 'WAL', 'OFF']);
  if (typeof value.integrity === 'string') {
    // SQLite failure diagnostics can contain private identifiers. Keep their
    // digest rather than turning an unrecognized diagnostic into "ok".
    result.integrity = value.integrity === 'ok' ? 'ok' : hashText(value.integrity);
  }
  const worker = runtimeFacts(value.worker);
  if (worker) {
    boolean(worker, value.worker, 'threadIsolated');
    result.worker = worker;
  }
  return Object.keys(result).length ? result : undefined;
}

function probeFacts(value) {
  if (!plain(value)) return undefined;
  const result = {};
  integer(result, value, 'protocolVersion');
  const runtime = runtimeFacts(value.runtime);
  const storage = storageFacts(value.storage);
  if (runtime) result.runtime = runtime;
  if (storage) result.storage = storage;
  return Object.keys(result).length ? result : undefined;
}

function memoryRecord(value, selectedId) {
  if (!plain(value) || value.id !== selectedId) return undefined;
  const result = { id: selectedId };
  integer(result, value, 'revision');
  choice(result, value, 'lifecycle', ['current', 'archived', 'tombstoned', 'superseded']);
  const classification = {};
  choice(classification, value, 'track', ['profile', 'facts', 'key', 'project_log', 'daily_log']);
  choice(classification, value, 'layer', ['anchor', 'structural', 'knowledge', 'contextual', 'self']);
  choice(classification, value, 'kind', ['fact', 'preference', 'rule', 'procedure', 'decision', 'event', 'entity', 'relation', 'note']);
  choice(classification, value, 'authority', ['candidate', 'derived', 'canonical']);
  choice(classification, value, 'validation', ['unverified', 'verified', 'reviewed', 'invalid', 'doubted', 'stale', 'expired']);
  choice(classification, value, 'confidence', ['unknown', 'low', 'medium', 'high']);
  choice(classification, value, 'importance', ['low', 'normal', 'high', 'critical']);
  choice(classification, value.scope, 'sensitivity', ['public', 'internal', 'private', 'restricted']);
  choice(classification, value.scope, 'sharing', ['local', 'team', 'git', 'provider']);
  if (Object.keys(classification).length) result.classification = classification;
  for (const key of ['title', 'body'])
    if (typeof value[key] === 'string') result[key] = hashText(value[key]);
  integer(result, value, 'totalChars');
  integer(result, value, 'nextOffset');
  if (value.nextOffset === null) result.nextOffset = null;
  boolean(result, value, 'truncated');
  return result;
}

function memoryData(value, action, selectedId) {
  if (!plain(value)) return undefined;
  if (action === 'read' || action === 'expand') return memoryRecord(value, selectedId);
  const record = memoryRecord(value.record, selectedId);
  if (!record) return undefined;
  const result = { record };
  boolean(result, value, 'committed');
  boolean(result, value, 'duplicate');
  if (plain(value.receipt)) {
    const receipt = {};
    boolean(receipt, value.receipt, 'committed');
    choice(receipt, value.receipt, 'state', ['committed']);
    if (Object.keys(receipt).length) result.receipt = receipt;
  }
  return result;
}

function graphData(value, options) {
  if (!plain(value) || !options.graphId || value.id !== options.graphId
    || value.title !== options.graphTitle) return undefined;
  const result = { id: options.graphId, title: hashText(value.title) };
  integer(result, value, 'revision');
  integer(result, value, 'layoutRevision');
  boolean(result, value, 'archived');
  for (const [key, count] of [['nodes', 'nodeCount'], ['edges', 'edgeCount'], ['materials', 'materialCount']])
    if (Array.isArray(value[key])) result[count] = value[key].length;
  return result;
}

function responseKind(value, options) {
  if (!plain(value)) return undefined;
  if (value.method === 'host.probe' && value.action === 'probe') return 'probe';
  if (!['nexus.query', 'nexus.command'].includes(value.method)) return undefined;
  if (value.domain === 'memory' && ['save', 'commit', 'update', 'forget', 'read', 'expand'].includes(value.action)) return 'memory';
  if (options.graphId && value.domain === 'graph' && ['create', 'get'].includes(value.action)) return 'graph';
  return undefined;
}

function projectResponse(value, index, kind, options) {
  const projected = { index, method: value.method, action: value.action };
  if (kind !== 'probe') projected.domain = value.domain;
  if (Number.isInteger(value.status) && value.status >= 100 && value.status <= 599)
    projected.httpStatus = value.status;
  boolean(projected, value, 'bodyTruncated');
  let body;
  try {
    if (typeof value.body === 'string') body = JSON.parse(value.body);
    projected.bodyParsed = typeof value.body === 'string';
  } catch {
    projected.bodyParsed = false;
  }
  if (kind !== 'probe') projected.canaryMatched = false;
  if (!plain(body)) return projected;
  const bodyError = projectError(body.error);
  if (bodyError) projected.error = bodyError;
  if (!plain(body.result)) return projected;
  const outer = body.result, result = {};
  boolean(result, outer, 'ok');
  const outerError = projectError(outer.error);
  if (outerError) result.error = outerError;
  if (plain(outer.value)) {
    const inner = outer.value, business = {};
    boolean(business, inner, 'ok');
    const innerError = projectError(inner.error);
    if (innerError) business.error = innerError;
    // No successful-looking data is published when any independent boundary
    // failed, is absent, or has a truncated observation.
    if (projected.httpStatus >= 200 && projected.httpStatus < 300
      && outer.ok === true && inner.ok === true && value.bodyTruncated === false) {
      const data = kind === 'probe' ? probeFacts(inner.data)
        : kind === 'memory' ? memoryData(inner.data, value.action, options.memoryId)
          : graphData(inner.data, options);
      if (data) {
        business.data = data;
        if (kind !== 'probe') {
          projected.canaryMatched = true;
          if (plain(inner.receipt) && ['succeeded', 'failed'].includes(inner.receipt.outcome))
            business.receipt = { outcome: inner.receipt.outcome };
        }
      }
    }
    if (inner.ok === false && plain(inner.receipt) && inner.receipt.outcome === 'failed')
      business.receipt = { outcome: 'failed' };
    result.value = business;
  }
  projected.result = result;
  return projected;
}

/** Project only observed host facts and explicitly selected synthetic records.
 * No input property is copied by object spread. Identities are caller bindings,
 * not a claim that this offline projection verified the installed package. */
export function projectDesktopObservation(inputBytes, identityOptions) {
  const options = validateDesktopProjectionOptions(identityOptions);
  if (typeof inputBytes !== 'string' && !(inputBytes instanceof Uint8Array))
    invalid('Desktop projection requires saved JSON bytes');
  const bytes = typeof inputBytes === 'string' ? Buffer.from(inputBytes, 'utf8') : inputBytes;
  let observation;
  try {
    observation = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, ''));
  } catch {
    invalid('Desktop observation must be valid UTF-8 JSON');
  }
  if (!plain(observation)) invalid('Desktop observation must be a JSON object');
  const result = {
    schemaVersion: 1,
    kind: 'desktop-public-observation',
    packageSha256: options.packageSha256,
    sourceHash: options.sourceHash,
    observationSha256: digest(bytes),
    selection: {
      memoryId: options.memoryId,
      ...(options.graphId ? { graphId: options.graphId, graphTitle: hashText(options.graphTitle) } : {}),
    },
  };
  boolean(result, observation, 'actualInstalledRenderer');
  boolean(result, observation, 'desktopPreloadPresent');
  integer(result, observation, 'desktopProtocolVersion');
  if (observation.desktopProtocolVersion === null) result.desktopProtocolVersion = null;
  if (typeof observation.observedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(observation.observedAt)
    && Number.isFinite(Date.parse(observation.observedAt))) result.observedAt = observation.observedAt;
  if (plain(observation.rendererLocation)) {
    const location = observation.rendererLocation;
    if (['dsh-app:', 'http:', 'https:', 'file:', 'chrome-extension:'].includes(location.protocol))
      result.rendererProtocol = location.protocol;
    if (typeof location.hostname === 'string') result.rendererHostname =
      ['app', 'localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
        ? location.hostname : hashText(location.hostname);
  }
  if (plain(observation.viewport)) {
    const viewport = {};
    for (const key of ['width', 'height', 'devicePixelRatio'])
      if (typeof observation.viewport[key] === 'number' && Number.isFinite(observation.viewport[key])
        && observation.viewport[key] > 0) viewport[key] = observation.viewport[key];
    if (Object.keys(viewport).length) result.viewport = viewport;
  }
  if (Array.isArray(observation.errors)) result.errors = {
    count: observation.errors.length,
    names: observation.errors.flatMap(error => plain(error) && errorNames.has(error.name) ? [error.name] : []),
  };
  result.responses = Array.isArray(observation.nexusResponses)
    ? observation.nexusResponses.flatMap((response, index) => {
      const kind = responseKind(response, options);
      return kind ? [projectResponse(response, index, kind, options)] : [];
    }) : [];
  return result;
}
