// Missed-Call Text-Back + AI Receptionist — one server, many clients.
// Each client business gets its own Twilio number, listed in clients.json.
require('dotenv').config({ quiet: true });
const http = require('http');
const express = require('express');
const twilio = require('twilio');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const crypto = require('crypto');
const { handleSession } = require('./receptionist');
const outreach = require('./outreach');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  // Log method and path only: avoid query-string secrets and caller phone numbers.
  console.log(`>>> ${req.method} ${req.path}`);
  next();
});

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PUBLIC_URL = '', // e.g. https://your-app.onrender.com
  PORT = 3000,
  SKIP_SIGNATURE_CHECK, // "true" only for local testing
} = process.env;

const client = TWILIO_ACCOUNT_SID ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;
const { VoiceResponse, MessagingResponse } = twilio.twiml;

// clients.json maps each Twilio number -> business settings
const clients = JSON.parse(fs.readFileSync(__dirname + '/clients.json', 'utf8'));
for (const n in clients) clients[n].twilioNumber = n;
const getBiz = (twilioNumber) => clients[twilioNumber];

// Remembers the last customer who texted each business, so the owner can just reply.
const lastCustomer = {};

// Only accept requests that really come from Twilio
function verifyTwilio(req, res, next) {
  // Signature bypass is allowed only outside production (e.g. local simulated tests).
  if (SKIP_SIGNATURE_CHECK === 'true' && process.env.NODE_ENV !== 'production') return next();
  if (!TWILIO_AUTH_TOKEN || !PUBLIC_URL) {
    console.error('Twilio signature validation is not configured.');
    return res.status(503).send('Webhook validation unavailable');
  }
  let ok = false;
  try {
    ok = twilio.validateRequest(
      TWILIO_AUTH_TOKEN,
      req.headers['x-twilio-signature'] || '',
      PUBLIC_URL.replace(/\/$/, '') + req.originalUrl,
      req.body
    );
  } catch (e) {
    console.warn('Twilio signature validation failed:', e.message);
  }
  return ok ? next() : res.status(403).send('Forbidden');
}

async function sendSms(from, to, body) {
  if (!client) return console.log(`[DRY RUN] SMS ${from} -> ${to}: ${body}`);
  await client.messages.create({ from, to, body });
}

// Hand the call to the AI receptionist
function connectAI(twiml, biz) {
  const connect = twiml.connect({ action: '/relay-end' });
  connect.conversationRelay({
    url: PUBLIC_URL.replace(/^http/, 'ws') + '/relay',
    welcomeGreeting: biz.aiGreeting || `Thanks for calling ${biz.name}! How can I help you today?`,
    ...(biz.aiVoice ? { voice: biz.aiVoice } : {}),
  });
}

// 1) Incoming call
app.post('/voice', verifyTwilio, (req, res) => {
  const biz = getBiz(req.body.To);
  const twiml = new VoiceResponse();
  if (!biz) {
    twiml.say('Sorry, this number is not set up.');
  } else if (biz.aiMode === 'always') {
    connectAI(twiml, biz);
  } else {
    const dial = twiml.dial({ timeout: biz.ringSeconds || 20, action: '/call-status', callerId: req.body.From });
    dial.number(biz.ownerPhone);
  }
  res.type('text/xml').send(twiml.toString());
});

// 2) Owner's phone finished ringing
app.post('/call-status', verifyTwilio, async (req, res) => {
  const { To, From, DialCallStatus } = req.body;
  const biz = getBiz(To);
  const twiml = new VoiceResponse();

  if (biz && DialCallStatus !== 'completed') {
    if (biz.aiMode === 'after-missed') {
      connectAI(twiml, biz);
      try {
        await sendSms(To, From, biz.textBackMessage);
        await sendSms(To, biz.ownerPhone, `Missed call from ${From}. AI receptionist is handling it.`);
        lastCustomer[To] = From;
      } catch (e) {
        console.error('SMS error:', e.message);
      }
      console.log(`[${biz.name}] missed call from ${From} -> AI receptionist`);
    } else {
      twiml.say(`Sorry we missed your call. We'll text you right away.`);
      twiml.hangup();
      try {
        await sendSms(To, From, biz.textBackMessage);
        await sendSms(To, biz.ownerPhone, `Missed call from ${From}. Auto-text sent. Reply to this number to text them.`);
        lastCustomer[To] = From;
        console.log(`[${biz.name}] missed call from ${From} (${DialCallStatus}) -> texted back`);
      } catch (e) {
        console.error('SMS error:', e.message);
      }
    }
  } else {
    twiml.hangup();
  }
  res.type('text/xml').send(twiml.toString());
});

// 3) AI conversation ended
app.post('/relay-end', verifyTwilio, (req, res) => {
  const biz = getBiz(req.body.To);
  const twiml = new VoiceResponse();
  let handoff = {};
  try { handoff = JSON.parse(req.body.HandoffData || '{}'); } catch {}

  if (biz && handoff.reason === 'transfer') {
    const dial = twiml.dial({ timeout: biz.ringSeconds || 20, callerId: req.body.From });
    dial.number(biz.ownerPhone);
    sendSms(req.body.To, biz.ownerPhone, `AI is transferring a caller to you: ${req.body.From}. Reason: ${handoff.detail || 'n/a'}`).catch(() => {});
  } else {
    twiml.hangup();
  }
  if (biz) lastCustomer[req.body.To] = req.body.From;
  res.type('text/xml').send(twiml.toString());
});

// 4) Texts to the business number
app.post('/sms', verifyTwilio, async (req, res) => {
  const { To, From, Body = '' } = req.body;
  const biz = getBiz(To);
  if (!biz) return res.type('text/xml').send(new MessagingResponse().toString());

  try {
    if (From === biz.ownerPhone) {
      const m = Body.match(/^(\+\d{10,15})\s+([\s\S]+)/);
      const target = m ? m[1] : lastCustomer[To];
      const text = m ? m[2] : Body;
      if (target) await sendSms(To, target, text);
      else await sendSms(To, biz.ownerPhone, 'No customer to reply to yet.');
    } else {
      lastCustomer[To] = From;
      await sendSms(To, biz.ownerPhone, `From ${From}: ${Body}`);
    }
  } catch (e) {
    console.error('SMS error:', e.message);
  }
  res.type('text/xml').send(new MessagingResponse().toString());
});

// Owner can see upcoming bookings
app.get('/bookings', requireAdmin, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const all = await require('./calendar').load();
    res.json(all.filter(b => b.start >= now).sort((a, b) => a.start.localeCompare(b.start)));
  } catch (e) {
    console.error('Bookings load failed:', e.message);
    res.status(500).json({ error: 'Unable to load bookings' });
  }
});

// ─── LANDING PAGE + DEMO REQUESTS ───────────────────────────────────────────
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.send('Missed-call text-back + AI receptionist is running.'));

const DEMO_FILE = path.join(__dirname, 'data', 'demo-requests.json');
const demoHits = new Map(); // ip -> [timestamps], simple spam limit

const useMongo = () => !!process.env.MONGODB_URI;

async function loadDemoRequests() {
  if (useMongo()) {
    const db = await outreach.getDb();
    return db.collection('demo_requests').find({}, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
  }
  try { return JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8')); } catch { return []; }
}

async function saveDemoRequest(entry) {
  if (useMongo()) {
    const db = await outreach.getDb();
    await db.collection('demo_requests').insertOne({ ...entry });
    return;
  }
  fs.mkdirSync(path.dirname(DEMO_FILE), { recursive: true });
  let all = [];
  try { all = JSON.parse(fs.readFileSync(DEMO_FILE, 'utf8')); } catch {}
  all.push(entry);
  fs.writeFileSync(DEMO_FILE, JSON.stringify(all, null, 2));
}

app.post('/demo-request', async (req, res) => {
  const wantsJson = (req.get('accept') || '').includes('application/json');
  const fail = (code, error) => wantsJson ? res.status(code).json({ error }) : res.status(code).send(error);
  const b = req.body || {};
  const clean = (v, max) => String(v || '').trim().slice(0, max);

  // Honeypot: real visitors never fill this hidden field.
  if (b.website) return wantsJson ? res.json({ status: 'ok' }) : res.redirect(303, '/?sent=1#demo');

  // Max 5 requests per IP per hour.
  const now = Date.now();
  const hits = (demoHits.get(req.ip) || []).filter(t => now - t < 60 * 60 * 1000);
  if (hits.length >= 5) return fail(429, 'Too many requests from this connection. Try again in an hour.');
  hits.push(now); demoHits.set(req.ip, hits);

  const entry = {
    name: clean(b.name, 80),
    business: clean(b.business, 120),
    phone: clean(b.phone, 25),
    email: clean(b.email, 120),
    trade: clean(b.trade, 40),
    missedCalls: clean(b.missedCalls, 20),
    notes: clean(b.notes, 1000),
    createdAt: new Date().toISOString(),
  };
  if (!entry.name || !entry.business || !entry.trade) return fail(400, 'Please fill in your name, business name, and trade.');
  if (entry.phone.replace(/\D/g, '').length < 10) return fail(400, 'Please enter a 10-digit phone number.');
  if (entry.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(entry.email)) return fail(400, 'That email address looks incomplete.');

  try {
    await saveDemoRequest(entry);
  } catch (e) {
    console.error('Demo request save failed:', e.message);
    return fail(500, 'The request could not be saved. Try again in a minute.');
  }
  console.log(`[Demo] New request from ${entry.business} (${entry.trade})`);
  return wantsJson ? res.json({ status: 'ok' }) : res.redirect(303, '/?sent=1#demo');
});

// View saved demo requests (requires x-admin-key header)
app.get('/demo-requests', requireAdmin, async (req, res) => {
  try {
    res.json(await loadDemoRequests());
  } catch (e) {
    console.error('Demo requests load failed:', e.message);
    res.status(500).json({ error: 'Unable to load demo requests' });
  }
});
// ─────────────────────────────────────────────────────────────────────────────

// ─── KEEP-ALIVE PING (prevents Render free tier from sleeping) ───────────────
if (PUBLIC_URL) {
  const PING_INTERVAL = 10 * 60 * 1000; // 10 minutes
  const pingUrl = PUBLIC_URL + '/';
  setInterval(() => {
    const mod = pingUrl.startsWith('https') ? require('https') : require('http');
    mod.get(pingUrl, (res) => {
      console.log(`[KeepAlive] ping ${res.statusCode}`);
    }).on('error', (e) => {
      console.error('[KeepAlive] ping failed:', e.message);
    });
  }, PING_INTERVAL);
  console.log(`[KeepAlive] pinging ${pingUrl} every 10 min`);
}
// ─────────────────────────────────────────────────────────────────────────────

// ─── OUTREACH ROUTES ────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_KEY;
  const supplied = req.get('x-admin-key');
  if (!expected || !supplied) return res.status(403).send('Forbidden');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  if (expectedBuffer.length !== suppliedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    return res.status(403).send('Forbidden');
  }
  next();
}

app.post('/outreach', requireAdmin, async (req, res) => {
  const { phone, delay_hours = 24, skip_if_contacted = 'true' } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  if (skip_if_contacted === 'true' && await outreach.alreadyContacted(phone)) {
    return res.json({ status: 'already_contacted', phone });
  }

  const biz = Object.values(clients)[0];
  const fromNumber = biz.twilioNumber;

  try {
    const smsSid = await outreach.smsProspect(client, fromNumber, phone, biz.name);
    console.log(`[Outreach] SMS sent to ${phone}, sid=${smsSid}`);

    const delayMs = parseFloat(delay_hours) * 60 * 60 * 1000;
    setTimeout(async () => {
      try {
        const callSid = await outreach.callProspect(client, fromNumber, phone, PUBLIC_URL);
        console.log(`[Outreach] Call to ${phone} started, sid=${callSid}`);
      } catch (e) {
        console.error(`[Outreach] Call to ${phone} failed:`, e.message);
      }
    }, delayMs);

    res.json({ status: 'outreach_started', phone, smsSid, call_in_hours: delay_hours });
  } catch (e) {
    console.error('[Outreach] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.all('/outreach-twiml', (req, res) => {
  const biz = Object.values(clients)[0];
  const twiml = new VoiceResponse();
  const connect = twiml.connect({ action: '/relay-end' });
  connect.conversationRelay({
    url: PUBLIC_URL.replace(/^http/, 'ws') + '/relay',
    welcomeGreeting:
      `Hi there! I'm calling from ${biz.name}. ` +
      `We help local businesses never miss a sales call — our AI answers when you're busy ` +
      `and automatically texts back missed callers. We also do professional website redesigns. ` +
      `Is this a good time to hear more? Just say yes or no.`,
    ...(biz.aiVoice ? { voice: biz.aiVoice } : {}),
  });
  res.type('text/xml').send(twiml.toString());
});

app.post('/outreach-status', verifyTwilio, async (req, res) => {
  const { To, CallStatus } = req.body;
  console.log(`[Outreach] Call to ${To} ended: ${CallStatus}`);
  try {
    const db = await outreach.getDb();
    await db.collection('outreach_log').updateOne(
      { phone: To },
      { $set: { call_status: CallStatus, call_updated_at: new Date().toISOString() } }
    );
  } catch (e) {
    console.error('[Outreach] Status update error:', e.message);
  }
  res.sendStatus(200);
});

app.get('/outreach-log', requireAdmin, async (req, res) => {
  try {
    res.json(await outreach.loadLog());
  } catch (e) {
    console.error('Outreach log load failed:', e.message);
    res.status(500).json({ error: 'Unable to load outreach log' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

// WebSocket for the AI receptionist. Authenticate the initial upgrade before accepting it.
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const requestUrl = req.url || '/';
  const pathname = requestUrl.split('?')[0];
  if (pathname !== '/relay') {
    socket.destroy();
    return;
  }

  const allowLocalBypass = SKIP_SIGNATURE_CHECK === 'true' && process.env.NODE_ENV !== 'production';

  // Never accept an unauthenticated relay connection if production config is incomplete.
  if (!allowLocalBypass && (!TWILIO_AUTH_TOKEN || !PUBLIC_URL)) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  let valid = allowLocalBypass;
  if (!allowLocalBypass) {
    const signature = req.headers['x-twilio-signature'] || '';
    // ConversationRelay signatures use the WebSocket URL (wss://), including its query string.
    const signatureUrl = PUBLIC_URL.replace(/\/$/, '').replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + requestUrl;
    try {
      valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, signatureUrl, {});
    } catch (e) {
      console.warn('WebSocket signature validation failed:', e.message);
      valid = false;
    }
  }

  if (!valid) {
    console.warn('Rejected unauthenticated /relay WebSocket handshake');
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  console.log('>>> Authenticated WebSocket /relay connected');
  handleSession(ws, { getBiz, sendSms });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Listening on ${PORT}`));
}
module.exports = { app, server, wss, lastCustomer, getBiz, sendSms };
