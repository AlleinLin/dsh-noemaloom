import { Readable } from 'node:stream';

export const COMPUTER_USE_API = '/api/plugins/dsh-noemaloom/computer-use';
const routes = new Set(['status', 'state', 'probe', 'doctor']);

/**
 * Keep the upstream JSON handlers behind the rc.5 owner-only Connection channel.
 * Raw webServer routes would bypass the carrier's Origin, login and principal
 * checks. The native chip and its per-session grant table retain ownership.
 */
export function authenticatedComputerUseRoutes(ctx) {
  return {
    register(definition) {
      const name = definition.path.replace(/^\/computer-use\//u, '');
      if (definition.kind !== 'exact' || !routes.has(name)) {
        throw new Error(`Unreviewed computer-use route: ${definition.path}`);
      }
      return ctx.connection.fetch.register({
        path: `${COMPUTER_USE_API}/${name}`,
        methods: name === 'state' ? ['GET', 'POST'] : ['GET'],
        requestBody: 'buffered',
        async fetch(request) {
          request.signal.throwIfAborted();
          const incoming = request.body === null ? Readable.from([]) : Readable.fromWeb(request.body);
          incoming.method = request.method;
          incoming.url = request.url;
          incoming.headers = Object.fromEntries(request.headers);
          let status = 200;
          let headers = {};
          let response;
          const outgoing = {
            get statusCode() { return status; },
            set statusCode(value) { status = value; },
            setHeader(name, value) { headers[name] = value; return outgoing; },
            writeHead(code, values = {}) { status = code; headers = values; return outgoing; },
            end(body) {
              if (response) throw new Error('Computer-use handler ended its response twice');
              response = new Response(body, { status, headers });
            },
          };
          try {
            await definition.handler(incoming, outgoing);
            request.signal.throwIfAborted();
            if (!response) throw new Error('Computer-use handler did not finish its response');
            return response;
          } finally {
            incoming.destroy();
          }
        },
      });
    },
  };
}
