import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  hostHeaderValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import { httpConfig } from './http/httpConfig.js';
import { createBearerCheck } from './http/auth.js';
import { createServer } from './server.js';

// Host names clients may use to reach this server (DNS-rebinding protection).
// host.docker.internal = n8n running inside Docker on the same machine.
const ALLOWED_HOSTS = ['localhost', '127.0.0.1', '[::1]', 'host.docker.internal'];

const handler = createMcpHandler(createServer); // fresh McpServer per request (stateless)
const nodeHandler = toNodeHandler(handler);
const validateHost = hostHeaderValidation(ALLOWED_HOSTS);
const validateOrigin = localhostOriginValidation(); // requests without Origin (n8n) pass
const isAuthorized = createBearerCheck(httpConfig.MCP_HTTP_TOKEN);

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const httpServer = createHttpServer((req, res) => {
  // 1) DNS-rebinding guards. On failure they already answered 403.
  if (!validateHost(req, res) || !validateOrigin(req, res)) return;

  const path = new URL(req.url ?? '/', 'http://localhost').pathname;

  // 2) Liveness probe without auth. Reveals nothing about the store.
  if (path === '/healthz' && req.method === 'GET') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // 3) Only /mcp is served.
  if (path !== '/mcp') {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  // 4) Bearer token (constant-time compare).
  if (!isAuthorized(req)) {
    // Log failed attempts for auditing. Never log the header value itself.
    const auth = req.headers.authorization;
    const authInfo = typeof auth === 'string' ? `present, ${auth.length} chars` : 'missing';
    console.error(
      `[auth] 401 ${req.method} ${path} from ${req.socket.remoteAddress ?? 'unknown'} (Authorization header: ${authInfo})`,
    );
    sendJson(res, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    return;
  }

  // 5) MCP protocol. Log technical details to stderr only, never to the client.
  nodeHandler(req, res).catch((err: unknown) => {
    console.error('MCP handler error:', err);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    else res.end();
  });
});

const { MCP_HTTP_HOST: host, MCP_HTTP_PORT: port } = httpConfig;

httpServer.listen(port, host, () => {
  console.error(`agent-action-gateway MCP server on http://${host}:${port}/mcp`);
  if (host !== '127.0.0.1') {
    console.error('WARNING: listening beyond localhost. Make sure the token is strong.');
  }
});

async function shutdown(): Promise<void> {
  console.error('Shutting down...');
  httpServer.close();
  await handler.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());