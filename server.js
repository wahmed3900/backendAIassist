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
  console.log(`>>> ${req.method} ${req.originalUrl} | To=${req.body?.To} From=${req.body?.From}`);
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
  if (SKIP_SIGNATURE_CHECK === 'true') return next();
  if (!TWILIO_AUTH_TOKEN || !PUBLIC_URL) {
    return res.status(503).send('Webhook validation unavailable');
  }
  const ok = twilio.validateRequest(
    TWILIO_AUTH_TOKEN,
    req.headers['x-twilio-signature'] || '',
    PUBLIC_URL.replace(/\/$/, '') + req.originalUrl,
    req.body
  );
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

// Admin Authentication Middleware
function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_KEY;
  const supplied = req.get('x-admin-key') || (req.body && req.body.key) || req.query.key;
  if (!expected || !supplied) return res.status(403).send('Forbidden');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const suppliedBuffer = Buffer.from(supplied, 'utf8');
  if (expectedBuffer.length !== suppliedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    return res.status(403).send('Forbidden');
  }
  next();
}

// Owner can see upcoming bookings
app.get('/bookings', requireAdmin, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const all = await require('./calendar').load();
    res.json(all.filter(b => b.start >= now).sort((a, b) => a.start.localeCompare(b.start)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Landing page (public/index.html) + its demo form
app.use(express.static(__dirname + '/public'));
app.get('/', (_, res) => res.sendFile(__dirname + '/public/index.html'));
app.get('/health', (_, res) => res.send('Missed-call text-back + AI receptionist is running.'));

app.post('/demo-request', async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.json({ ok: true }); // spam bot filled the hidden field
  const clean = (v, n) => String(v || '').trim().slice(0, n);
  const lead = {
    name: clean(b.name, 80), business: clean(b.business, 120), phone: clean(b.phone, 25),
    email: clean(b.email, 120), trade: clean(b.trade, 40), missedCalls: clean(b.missedCalls, 40),
    notes: clean(b.notes, 1000),
  };
  if (!lead.name || !lead.business || lead.phone.replace(/\D/g, '').length < 10) {
    return res.status(400).json({ ok: false, error: 'Missing name, business or phone' });
  }
  console.log('[DEMO REQUEST]', JSON.stringify(lead));
  try {
    const [from, biz] = Object.entries(clients).find(([, c]) => c.demo) || Object.entries(clients)[0];
    const text = `New demo request (sacaireceptionist.com)\n${lead.name} - ${lead.business}\n${lead.phone}` +
      (lead.email ? `\n${lead.email}` : '') + `\nTrade: ${lead.trade}` +
      (lead.missedCalls ? `\nMissed calls: ${lead.missedCalls}` : '') + (lead.notes ? `\n${lead.notes}` : '');
    await sendSms(from, biz.ownerPhone, text.slice(0, 1500));
  } catch (e) {
    console.error('Demo request text failed:', e.message);
  }
  res.json({ ok: true });
});

// ─── OUTREACH ROUTES ────────────────────────────────────────────────────────

app.post('/outreach', requireAdmin, async (req, res) => {
  const { phone, delay_hours = 24, skip_if_contacted = 'true' } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  if (skip_if_contacted === 'true' && outreach.alreadyContacted(phone)) {
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

app.post('/outreach-status', verifyTwilio, (req, res) => {
  const { To, CallStatus } = req.body;
  console.log(`[Outreach] Call to ${To} ended: ${CallStatus}`);
  const log = outreach.loadLog();
  if (log[To]) {
    log[To].call_status = CallStatus;
    log[To].call_updated_at = new Date().toISOString();
    outreach.saveLog(log);
  }
  res.sendStatus(200);
});

app.get('/outreach-log', requireAdmin, (req, res) => {
  res.json(outreach.loadLog());
});

// ─────────────────────────────────────────────────────────────────────────────

// WebSocket for the AI receptionist with secure upgrade handling
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

  if (!allowLocalBypass && (!TWILIO_AUTH_TOKEN || !PUBLIC_URL)) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  let valid = allowLocalBypass;
  if (!allowLocalBypass) {
    const signature = req.headers['x-twilio-signature'] || '';
    const signatureUrl = PUBLIC_URL.replace(/\/$/, '').replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:') + requestUrl;
    try {
      valid = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, signatureUrl, {});
    } catch (e) {
      valid = false;
    }
  }

  if (!valid) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  console.log('>>> WebSocket /relay connected');
  handleSession(ws, { getBiz, sendSms });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Listening on ${PORT}`));
}
module.exports = { app, server, wss, lastCustomer, getBiz, sendSms };
