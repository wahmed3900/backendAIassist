// Stripe Checkout and subscription webhooks. Stripe secrets stay server-side.
const https = require('https');
const {
  createHmac,
  randomInt,
  randomUUID,
  timingSafeEqual,
} = require('crypto');
const outreach = require('./outreach');

const STRIPE_API_VERSION = '2026-08-26.dahlia';
const PRODUCT_NAME = 'AI Receptionist';
const MONTHLY_PRICE_CENTS = 10000;
const TRIAL_DAYS = 7;

function stripeRequest(method, path, params) {
  const apiKey = process.env.STRIPE_API_KEY;
  if (!apiKey) {
    const error = new Error('Stripe billing is not configured on the server.');
    error.statusCode = 503;
    return Promise.reject(error);
  }

  const body = params ? new URLSearchParams(params).toString() : '';
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'api.stripe.com',
      path,
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Stripe-Version': STRIPE_API_VERSION,
        ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}),
        ...(params ? {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        } : {}),
      },
    }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch {
          return reject(new Error('Stripe returned an unreadable response.'));
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const error = new Error(parsed.error?.message || 'Stripe could not process the request.');
          error.statusCode = 502;
          return reject(error);
        }
        resolve(parsed);
      });
    });
    request.setTimeout(15000, () => request.destroy(new Error('Stripe request timed out.')));
    request.on('error', reject);
    if (params) request.write(body);
    request.end();
  });
}

function randomLabelSuffix() {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let suffix = '';
  for (let i = 0; i < 8; i += 1) suffix += letters[randomInt(letters.length)];
  return suffix;
}

async function createCheckoutSession(email) {
  const publicUrl = process.env.PUBLIC_URL;
  if (!publicUrl || !publicUrl.startsWith('https://')) {
    const error = new Error('The public HTTPS URL is not configured.');
    error.statusCode = 503;
    throw error;
  }

  const params = {
    mode: 'subscription',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(MONTHLY_PRICE_CENTS),
    'line_items[0][price_data][recurring][interval]': 'month',
    'line_items[0][price_data][product_data][name]': PRODUCT_NAME,
    'line_items[0][price_data][product_data][description]':
      'AI call answering, appointment booking, missed-call text-back, and owner notifications.',
    'line_items[0][quantity]': '1',
    'subscription_data[trial_period_days]': String(TRIAL_DAYS),
    'payment_method_collection': 'always',
    'allow_promotion_codes': 'true',
    'phone_number_collection[enabled]': 'true',
    customer_email: email,
    success_url: `${publicUrl}/success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${publicUrl}/#pricing`,
    integration_identifier: `ai-receptionist-${randomLabelSuffix()}`,
  };

  return stripeRequest('POST', '/v1/checkout/sessions', params);
}

function verifyWebhook(rawBody, signatureHeader) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error('Stripe webhook is not configured.');
  if (!Buffer.isBuffer(rawBody) || !signatureHeader) {
    throw new Error('Missing Stripe webhook body or signature.');
  }

  const parts = signatureHeader.split(',').map((part) => part.split('=', 2));
  const timestamp = parts.find(([key]) => key === 't')?.[1];
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value);
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || !signatures.length) {
    throw new Error('Invalid Stripe webhook signature.');
  }
  if (Math.abs(Date.now() / 1000 - timestampNumber) > 300) {
    throw new Error('Stripe webhook signature has expired.');
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest();
  const valid = signatures.some((signature) => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
    const provided = Buffer.from(signature, 'hex');
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  });
  if (!valid) throw new Error('Invalid Stripe webhook signature.');

  return JSON.parse(rawBody.toString('utf8'));
}

async function retrieveSubscription(subscriptionId) {
  return stripeRequest('GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
}

async function saveSubscriber({ subscription, email, phone, event }) {
  const customerId = typeof subscription.customer === 'string'
    ? subscription.customer
    : subscription.customer?.id;
  if (!customerId) return;

  const db = await outreach.getDb();
  const fields = {
    stripe_customer_id: customerId,
    stripe_subscription_id: subscription.id,
    status: subscription.status,
    trial_end: subscription.trial_end
      ? new Date(subscription.trial_end * 1000).toISOString()
      : null,
    current_period_end: subscription.current_period_end
      ? new Date(subscription.current_period_end * 1000).toISOString()
      : null,
    cancel_at_period_end: Boolean(subscription.cancel_at_period_end),
    source: 'website_checkout',
    last_stripe_event_id: event.id,
    updated_at: new Date().toISOString(),
  };
  if (email) fields.email = email;
  if (phone) fields.phone = phone;
  await db.collection('subscribers').updateOne(
    { _id: customerId },
    {
      $set: fields,
      $setOnInsert: { created_at: new Date().toISOString() },
    },
    { upsert: true }
  );
}

async function upsertSubscription(subscriptionId, email, phone, event) {
  if (!subscriptionId) return;
  const subscription = await retrieveSubscription(subscriptionId);
  await saveSubscriber({ subscription, email, phone, event });
}

async function handleWebhook(rawBody, signatureHeader) {
  const event = verifyWebhook(rawBody, signatureHeader);
  const db = await outreach.getDb();
  const processed = db.collection('stripe_webhook_events');
  if (await processed.findOne({ _id: event.id })) return { duplicate: true };

  const object = event.data?.object || {};
  if (
    (event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded') &&
    object.mode === 'subscription' &&
    object.payment_status !== 'unpaid'
  ) {
    const email = object.customer_details?.email || object.customer_email || null;
    const phone = object.customer_details?.phone || null;
    await upsertSubscription(object.subscription, email, phone, event);
  } else if (event.type.startsWith('customer.subscription.')) {
    await saveSubscriber({ subscription: object, event });
  } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
    const subscriptionId = object.subscription ||
      object.parent?.subscription_details?.subscription;
    if (subscriptionId) await upsertSubscription(subscriptionId, null, null, event);
  }

  await processed.updateOne(
    { _id: event.id },
    { $setOnInsert: { type: event.type, processed_at: new Date().toISOString() } },
    { upsert: true }
  );
  return { duplicate: false };
}

module.exports = {
  createCheckoutSession,
  handleWebhook,
  MONTHLY_PRICE_CENTS,
  TRIAL_DAYS,
};
