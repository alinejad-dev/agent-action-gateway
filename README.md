# Agent Action Gateway

[![CI](https://github.com/alinejad-dev/agent-action-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/alinejad-dev/agent-action-gateway/actions/workflows/ci.yml)

An MCP server that sits between AI agents and business systems, and enforces safety **in code, not in the prompt**.

AI agents are good at deciding *what* to do. They should not be the last line of defence for *whether* an action is allowed. This gateway gives agents (Claude Code, Claude Desktop, n8n) a small set of well-defined tools, and puts validation, authentication and data minimisation in front of the real system: currently a WooCommerce store.

> **Status: Phase 1 complete (read-only tools). Phase 2 (safe write actions) is in progress.** Write actions (refunds, cancellations) with a policy engine, live-state checks, idempotency, human approval and an audit log are being built. See [Roadmap](#roadmap).

## What it does today

| Tool | Description |
|---|---|
| `get_order` | Look up one order by numeric ID: status, total, items, refunded amount, customer **first name only** |
| `search_orders` | Find up to 10 orders by customer name or email |
| `ping` | Health check |

- **Two transports:** stdio (Claude Code / Claude Desktop) and Streamable HTTP (n8n and other remote clients)
- **Schema-validated inputs** (zod): invalid arguments are rejected before any network call
- **Consistent output envelope:** `{ ok: true, data }` or `{ ok: false, error: { code, message } }`

## Architecture

```mermaid
flowchart LR
    subgraph Clients
        CC[Claude Code / Desktop]
        N8N[n8n MCP Client<br/>in Docker]
    end

    subgraph Gateway[Agent Action Gateway]
        STDIO[stdio entry<br/>index.ts]
        HTTP[HTTP entry<br/>http.ts]
        GUARDS[Host + Origin guards<br/>Bearer token check]
        SERVER[MCP server<br/>tools + zod schemas]
        WOO[WooCommerce client<br/>OAuth 1.0a signing]
    end

    STORE[(WooCommerce<br/>REST API)]

    CC -->|stdio| STDIO --> SERVER
    N8N -->|Streamable HTTP<br/>Bearer token| HTTP --> GUARDS --> SERVER
    SERVER --> WOO -->|signed requests| STORE
```

Both entry points build the same server from one factory (`server.ts`). Over HTTP the server is **stateless**: a fresh instance per request.

## Security model

| Layer | What it does |
|---|---|
| Bearer token | Required on `/mcp`. Compared in constant time (SHA-256 + `timingSafeEqual`) to avoid timing attacks |
| Host header allowlist | Blocks DNS-rebinding attacks against the local server |
| Origin check | Rejects requests from other websites in a browser. Non-browser clients (no `Origin`) are allowed |
| Loopback bind | Listens on `127.0.0.1` by default, not on the network |
| Failed-auth logging | Logs method, path, source address and header length. **Never the token itself** |
| Data minimisation | Only the customer's first name reaches the model. No email, phone or address |
| Safe errors | Store and internal errors are mapped to generic codes. Technical details go to stderr, never to the model |
| Store credentials | OAuth 1.0a signing over HTTP (the secret is never sent); Basic Auth only over HTTPS. Use a **read-only** WooCommerce key |
| Client-side restriction | In n8n, the credential is restricted to `host.docker.internal`, so the token cannot be sent to any other domain |

Request order on the HTTP server: Host/Origin guards → `/healthz` (no auth, no data) → path check → Bearer token → MCP.

## Requirements

- Node.js 22.12 or later (developed and tested on Node 24)
- A WooCommerce store with a REST API key (read-only is enough)

## Setup

```bash
git clone https://github.com/alinejad-dev/agent-action-gateway.git
cd agent-action-gateway
npm install
cp .env.example .env    # then fill in real values
npm run build
```

Generate a strong token for the HTTP transport:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

| Variable | Needed for | Notes |
|---|---|---|
| `WOO_BASE_URL` | both | e.g. `http://localhost:8080` |
| `WOO_CONSUMER_KEY` / `WOO_CONSUMER_SECRET` | both | WooCommerce > Settings > Advanced > REST API |
| `MCP_HTTP_TOKEN` | HTTP only | At least 32 characters |
| `MCP_HTTP_PORT` | HTTP only | Default `3333` |
| `MCP_HTTP_HOST` | HTTP only | Default `127.0.0.1` |

The server fails fast on invalid configuration and prints only variable names, never values.

## Connect a client

### Claude Code (stdio)

```bash
claude mcp add action-gateway -- node /absolute/path/to/agent-action-gateway/dist/index.js
```

### n8n (Streamable HTTP)

1. Start the HTTP server: `npm run start:http`
2. In n8n, create a **Bearer Auth** credential with your `MCP_HTTP_TOKEN`. Set *Allowed HTTP Request Domains* to `host.docker.internal`.
3. Add an **MCP Client** node:
   - Server Transport: **HTTP Streamable**
   - Endpoint: `http://host.docker.internal:3333/mcp` (n8n running in Docker Desktop)
   - Authentication: **Bearer Auth**
4. Pick a tool from the list and run it.

## Scripts

| Command | What it does |
|---|---|
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the stdio server |
| `npm run start:http` | Run the HTTP server |
| `npm test` | Run unit tests (no `.env` or network needed) |
| `npm run smoke` | Build, start the stdio server and list its tools via MCP Inspector (needs `.env`) |
| `npm run typecheck` | Type-check without emitting |

## Tests

Unit tests (Vitest) cover the security-critical pure logic, and run on every push via GitHub Actions:

- **Bearer auth:** correct token, missing header, wrong token of the same length, prefix of the real token, extra characters, wrong scheme, empty token
- **Output envelope:** success and failure shapes; store and internal errors never leak details to the model
- **OAuth 1.0a signing:** signature matches a hand-written RFC 5849 base string; the secret never appears in the URL; fresh nonce per call; any changed parameter changes the signature

## Project structure

```
src/
  index.ts            stdio entry point
  http.ts             HTTP entry point (guards, auth, /healthz)
  server.ts           MCP server factory (registers tools)
  config.ts           env loading + validation (fail fast)
  http/
    auth.ts           constant-time bearer token check
    httpConfig.ts     HTTP-only settings
  tools/              MCP tools + output envelope
  woo/                WooCommerce client, OAuth signing, error types
test/                 Vitest unit tests
.github/workflows/    CI: typecheck, tests and build on every push
```

## Roadmap

- **Phase 2: Safe actions** *(in progress)*. `request_refund` and `cancel_order` behind a policy engine (rules in config, e.g. auto-approve small refunds, block outside the return window), live re-fetch of the order before acting, idempotency keys, and an audit log in Postgres. Store access goes through a platform-agnostic `StoreAdapter` interface, so actions are not tied to WooCommerce.
- **Phase 2.5: Shopify adapter.** The same `StoreAdapter` implemented for Shopify (GraphQL Admin API), starting with `get_order` and `request_refund`. The policy engine and safety checks stay unchanged across both stores.
- **Phase 3: Human in the loop.** Slack approval for sensitive actions, an approval-status tool, and attack tests (double-refund race, prompt injection in customer text).
- **Phase 4: Ship.** Demo video and extended docs.

## Notes

- Built with the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`).
- `@modelcontextprotocol/inspector` is a pinned dev dependency for `npm run smoke`. Its `postinstall` script is intentionally **not** approved in npm's `allowScripts`: the CLI mode used here works without it.

## License

MIT