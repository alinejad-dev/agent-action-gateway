import { describe, expect, it } from 'vitest';
import { storeRequest, type FetchLike, type StoreRequest } from '../src/woo/request.js';

// Fake credentials used only in tests.
const KEYS = { key: 'ck_test_key', secret: 'cs_test_secret' };
const HTTP_BASE = 'http://localhost:8080';
const HTTPS_BASE = 'https://shop.example.com';

type Call = { url: URL; init: RequestInit };

// A fake fetch that records every call and answers with the given function.
function fakeFetch(answer: () => Response | Promise<Response>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return answer();
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function req(overrides: Partial<StoreRequest> = {}): StoreRequest {
  return { baseUrl: HTTP_BASE, keys: KEYS, method: 'GET', path: '/orders/20', ...overrides };
}

describe('storeRequest: how the request is sent', () => {
  it('signs plain HTTP with OAuth 1.0a and never sends the secret', async () => {
    const fake = fakeFetch(() => json(200, {}));
    await storeRequest(req(), fake.fetch);
    const call = fake.calls[0]!;
    expect(call.url.origin + call.url.pathname).toBe('http://localhost:8080/wp-json/wc/v3/orders/20');
    expect(call.url.searchParams.get('oauth_consumer_key')).toBe(KEYS.key);
    expect(call.url.searchParams.get('oauth_signature')).toBeTruthy();
    expect(call.url.href).not.toContain(KEYS.secret);
    expect(new Headers(call.init.headers).has('Authorization')).toBe(false);
  });

  it('uses Basic Auth over HTTPS and adds no OAuth parameters', async () => {
    const fake = fakeFetch(() => json(200, {}));
    await storeRequest(req({ baseUrl: HTTPS_BASE }), fake.fetch);
    const call = fake.calls[0]!;
    const expected = `Basic ${Buffer.from(`${KEYS.key}:${KEYS.secret}`).toString('base64')}`;
    expect(new Headers(call.init.headers).get('Authorization')).toBe(expected);
    expect([...call.url.searchParams.keys()].some((k) => k.startsWith('oauth_'))).toBe(false);
  });

  it('never follows redirects and always sets a timeout', async () => {
    const fake = fakeFetch(() => json(200, {}));
    await storeRequest(req(), fake.fetch);
    expect(fake.calls[0]!.init.redirect).toBe('manual');
    expect(fake.calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends a POST body as JSON', async () => {
    const fake = fakeFetch(() => json(201, { id: 31 }));
    const body = { amount: '18.00', api_refund: false };
    await storeRequest(req({ method: 'POST', path: '/orders/20/refunds', body }), fake.fetch);
    const call = fake.calls[0]!;
    expect(call.init.method).toBe('POST');
    expect(call.init.body).toBe(JSON.stringify(body));
    expect(new Headers(call.init.headers).get('Content-Type')).toBe('application/json');
  });

  it('sends a GET without body and without Content-Type', async () => {
    const fake = fakeFetch(() => json(200, []));
    await storeRequest(req(), fake.fetch);
    expect(fake.calls[0]!.init.body).toBeUndefined();
    expect(new Headers(fake.calls[0]!.init.headers).has('Content-Type')).toBe(false);
  });

  it('adds query parameters and handles a trailing slash in the store address', async () => {
    const fake = fakeFetch(() => json(200, []));
    const query = { search: 'Daniel', per_page: '10' };
    await storeRequest(req({ baseUrl: 'http://localhost:8080/', path: '/orders', query }), fake.fetch);
    const url = fake.calls[0]!.url;
    expect(url.pathname).toBe('/wp-json/wc/v3/orders');
    expect(url.searchParams.get('search')).toBe('Daniel');
    expect(url.searchParams.get('per_page')).toBe('10');
  });
});

describe('storeRequest: what comes back', () => {
  it('returns the parsed body of a 2xx answer', async () => {
    const fake = fakeFetch(() => json(201, { id: 31, amount: '18.00' }));
    const answer = await storeRequest(req({ method: 'POST', path: '/orders/20/refunds', body: {} }), fake.fetch);
    expect(answer).toEqual({ status: 201, code: null, data: { id: 31, amount: '18.00' } });
  });

  it('returns only status and code for an error answer, never its message or stack trace', async () => {
    // Shape recorded from WooCommerce 11.1.2 (a PHP fatal error answer).
    const fake = fakeFetch(() =>
      json(500, {
        code: 'internal_server_error',
        message: 'There has been a critical error on this website.',
        data: { status: 500, error: { file: '/var/www/html/wp-content/plugins/woocommerce/x.php' } },
      }),
    );
    const answer = await storeRequest(req({ method: 'POST', path: '/orders/31/refunds', body: {} }), fake.fetch);
    expect(answer).toEqual({ status: 500, code: 'internal_server_error', data: null });
    expect(JSON.stringify(answer)).not.toContain('/var/www');
  });

  it('keeps a real WooCommerce error code', async () => {
    const fake = fakeFetch(() => json(500, { code: 'woocommerce_rest_cannot_create_order_refund', message: 'x', data: 500 }));
    const answer = await storeRequest(req({ method: 'POST', path: '/orders/20/refunds', body: {} }), fake.fetch);
    expect(answer?.code).toBe('woocommerce_rest_cannot_create_order_refund');
  });

  it.each([
    ['uppercase', 'Bad_Code'],
    ['spaces', 'bad code'],
    ['too long', 'a'.repeat(81)],
    ['not a string', 404],
    ['empty', ''],
  ])('drops an error code with an unsafe shape (%s)', async (_label, code) => {
    const fake = fakeFetch(() => json(400, { code }));
    const answer = await storeRequest(req(), fake.fetch);
    expect(answer).toEqual({ status: 400, code: null, data: null });
  });

  it('keeps the status when the body is not JSON', async () => {
    const fake = fakeFetch(() => new Response('<html>Bad Gateway</html>', { status: 502 }));
    expect(await storeRequest(req(), fake.fetch)).toEqual({ status: 502, code: null, data: null });
  });

  it('returns data null for an empty 2xx body', async () => {
    const fake = fakeFetch(() => new Response(null, { status: 204 }));
    expect(await storeRequest(req(), fake.fetch)).toEqual({ status: 204, code: null, data: null });
  });

  it('does not follow a redirect: the 3xx comes back as it is', async () => {
    const fake = fakeFetch(() => new Response(null, { status: 301, headers: { Location: 'http://evil.example.com/' } }));
    expect(await storeRequest(req(), fake.fetch)).toEqual({ status: 301, code: null, data: null });
    expect(fake.calls).toHaveLength(1);
  });

  it('returns null on a network error', async () => {
    const fake = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    expect(await storeRequest(req(), fake.fetch)).toBeNull();
  });

  it('returns null on a timeout', async () => {
    const fake = fakeFetch(() => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    });
    expect(await storeRequest(req({ method: 'POST', path: '/orders/20/refunds', body: {} }), fake.fetch)).toBeNull();
  });

  it('returns null when the body cannot be read to the end', async () => {
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new Error('connection reset'));
      },
    });
    const fake = fakeFetch(() => new Response(broken, { status: 201 }));
    expect(await storeRequest(req({ method: 'POST', path: '/orders/20/refunds', body: {} }), fake.fetch)).toBeNull();
  });
});

describe('storeRequest: refuses invalid arguments before sending anything', () => {
  it.each(['/orders/../users', '/orders?status=any', '/orders//20', '/Orders/20', 'orders/20', '/orders/20%2F', '/', ''])(
    'refuses the path %j',
    async (path) => {
      const fake = fakeFetch(() => json(200, {}));
      await expect(storeRequest(req({ path }), fake.fetch)).rejects.toThrow('path');
      expect(fake.calls).toHaveLength(0);
    },
  );

  it('refuses DELETE', async () => {
    const fake = fakeFetch(() => json(200, {}));
    const request = { ...req(), method: 'DELETE' } as unknown as StoreRequest;
    await expect(storeRequest(request, fake.fetch)).rejects.toThrow('method');
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a GET with a body', async () => {
    const fake = fakeFetch(() => json(200, {}));
    await expect(storeRequest(req({ body: {} }), fake.fetch)).rejects.toThrow('body');
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses query parameters that start with oauth_', async () => {
    const fake = fakeFetch(() => json(200, {}));
    await expect(storeRequest(req({ query: { oauth_signature: 'x' } }), fake.fetch)).rejects.toThrow('oauth_');
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a store address that is not http or https', async () => {
    const fake = fakeFetch(() => json(200, {}));
    await expect(storeRequest(req({ baseUrl: 'ftp://shop.example.com' }), fake.fetch)).rejects.toThrow('http');
    expect(fake.calls).toHaveLength(0);
  });

  it('never puts the secret into an error message', async () => {
    const fake = fakeFetch(() => json(200, {}));
    const error = await storeRequest(req({ path: '/bad path' }), fake.fetch).catch((e: unknown) => e);
    expect(String(error)).not.toContain(KEYS.secret);
  });
});