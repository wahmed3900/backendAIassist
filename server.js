// Missed-Call Text-Back + AI Receptionist — one server, many clients.
// Each client business gets its own Twilio number, listed in clients.json.
require('dotenv').config({ quiet: true });
const http = require('http');
const express = require('express');
const twilio = require('twilio');
const { WebSocketServer } = require('ws');
const fs = require('fs');
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
  const ok = twilio.validateRequest(
    TWILIO_AUTH_TOKEN,
    req.headers['x-twilio-signature'] || '',
    PUBLIC_URL + req.originalUrl,
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

// Owner can see upcoming bookings
app.get('/bookings', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) return res.status(403).send('Forbidden');
  try {
    const now = new Date().toISOString();
    const all = await require('./calendar').load();
    res.json(all.filter(b => b.start >= now).sort((a, b) => a.start.localeCompare(b.start)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (_, res) => res.send('Missed-call text-back + AI receptionist is running.'));

// ─── KEEP-ALIVE PING (prevents Render free tier from sleeping) ───────────────
// Pings itself every 10 minutes so the server never spins down.
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

// POST /outreach — send SMS now, schedule AI call after delay_hours
// Only the owner may start outreach: requires ADMIN_KEY (header x-admin-key or body "key").
function requireAdmin(req, res, next) {
  const key = req.get('x-admin-key') || (req.body && req.body.key);
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) return res.status(403).send('Forbidden');
  next();
}

app.post('/outreach', requireAdmin, async (req, res) => {
  const { phone, delay_hours = 24, skip_if_contacted = 'true' } = req.body;
  if (!phone) return res.status(400).json({ error: 'phone is required' });

  const delayHours = Number(delay_hours);
  if (!Number.isFinite(delayHours) || delayHours < 0) {
    return res.status(400).json({ error: 'delay_hours must be a non-negative number' });
  }

  const biz = Object.values(clients)[0];
  if (!biz) return res.status(500).json({ error: 'No business is configured' });
  const fromNumber = biz.twilioNumber;

  try {
    if (skip_if_contacted === 'true') {
      const existing = await outreach.getContact(phone);
      if (existing?.sms_sent_at) {
        // Recover records left between SMS delivery and call scheduling by an old
        // in-memory timer, instead of sending the SMS again or silently skipping.
        if (!existing.call_status && !existing.call_sid && !existing.call_started_at) {
          const callDueAt = await outreach.scheduleCall(phone, delayHours);
          return res.json({
            status: 'call_scheduled',
            phone,
            call_in_hours: delayHours,
            call_due_at: callDueAt.toISOString(),
            recovered: true,
          });
        }
        return res.json({ status: 'already_contacted', phone });
      }
    }

    const smsSid = await outreach.smsProspect(client, fromNumber, phone, biz.name);
    const callDueAt = await outreach.scheduleCall(phone, delayHours);
    console.log(`[Outreach] SMS sent to ${phone}, sid=${smsSid}`);
    console.log(`[Outreach] AI call scheduled for ${phone} at ${callDueAt.toISOString()}`);

    res.json({
      status: 'outreach_started',
      phone,
      smsSid,
      call_in_hours: delayHours,
      call_due_at: callDueAt.toISOString(),
    });
  } catch (e) {
    console.error('[Outreach] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET|POST /outreach-twiml — TwiML for the outbound AI sales call
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

// POST /outreach-status — Twilio posts here when an outbound call ends
// FIX: made async, uses MongoDB via loadLog() to update call status
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

// GET /outreach-log — view all contacts (requires ADMIN_KEY)
// FIX: made async, await loadLog() which now reads from MongoDB
app.get('/outreach-log', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(403).send('Forbidden');
  }
  res.json(await outreach.loadLog());
});

// ─────────────────────────────────────────────────────────────────────────────

// WebSocket for the AI receptionist
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/relay' });
wss.on('connection', (ws) => {
  console.log('>>> WebSocket /relay connected');
  handleSession(ws, { getBiz, sendSms });
});

// A single worker per process drains durable MongoDB jobs. MongoDB leases make
// claims safe across restarts and multiple running instances.
let outreachWorkerActive = false;
async function processOutreachQueue() {
  if (outreachWorkerActive || !client) return;
  outreachWorkerActive = true;
  let job = null;
  try {
    job = await outreach.claimDueCall();
    if (!job) return;
    const biz = Object.values(clients)[0];
    const callSid = await outreach.callProspect(client, biz.twilioNumber, job.phone, PUBLIC_URL);
    console.log(`[Outreach] Call to ${job.phone} started, sid=${callSid}`);
  } catch (e) {
    console.error('[Outreach] Scheduled call failed:', e.message);
    if (job) {
      try {
        await outreach.retryCall(job.phone, job.call_attempts || 1, e);
      } catch (retryError) {
        console.error('[Outreach] Could not update scheduled call:', retryError.message);
      }
    }
  } finally {
    outreachWorkerActive = false;
  }
}

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Listening on ${PORT}`);
    processOutreachQueue();
    setInterval(processOutreachQueue, 15 * 1000);
  });
}
module.exports = { app, server, wss, lastCustomer, getBiz, sendSms, processOutreachQueue };
