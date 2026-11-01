import { config } from '../config.js';
import { signOAuth1 } from '../woo/oauth.js';

// One-off diagnostic: can we read order #20 with our API key?
const url = new URL('/wp-json/wc/v3/orders/20', config.WOO_BASE_URL);
const signedUrl = signOAuth1('GET', url, config.WOO_CONSUMER_KEY, config.WOO_CONSUMER_SECRET);

// Note: never print signedUrl — it contains the consumer key.
const res = await fetch(signedUrl);
const body = (await res.json()) as Record<string, unknown>;

console.log('HTTP status:', res.status);
if (res.ok) {
  // Print only non-personal fields — no customer name, email or address.
  console.log('Order:', { id: body.id, status: body.status, total: body.total, currency: body.currency });
} else {
  console.log('Error:', { code: body.code, message: body.message });
}