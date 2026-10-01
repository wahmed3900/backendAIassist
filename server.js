// Missed-Call Text-Back + AI Receptionist — one server, many clients.
// Each client business gets its own Twilio number, listed in clients.json.
require('dotenv').config({ quiet: true });
const http = require('http');
const express = require('express');
const twilio = require('twilio');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const { handleSession } = require('./receptionist');

const app = express();
app.use(express.urlencoded({ extended: false }));

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PUBLIC_URL = '',          // e.g. https://your-app.onrender.com
  PORT = 3000,
  SKIP_SIGNATURE_CHECK,     // "true" only for local testing
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
//    aiMode "always"       -> AI answers every call
//    aiMode "after-missed" -> ring the owner first; AI picks up if they don't
//    no aiMode             -> ring the owner; text back if missed
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

// 3) AI conversation ended: transfer to the owner or hang up
app.post('/relay-end', verifyTwilio, (req, res) => {
  const biz = getBiz(req.body.To);
  const twiml = new VoiceResponse();
  let handoff = {};
  try { handoff = JSON.parse(req.body.HandoffData || '{}'); } catch {}

  if (biz && handoff.reason === 'transfer') {
    // If the owner doesn't answer the transfer, fall back to text-back
    const dial = twiml.dial({ timeout: biz.ringSeconds || 20, callerId: req.body.From });
    dial.number(biz.ownerPhone);
    sendSms(req.body.To, biz.ownerPhone, `AI is transferring a caller to you: ${req.body.From}. Reason: ${handoff.detail || 'n/a'}`).catch(() => {});
  } else {
    twiml.hangup();
  }
  if (biz) lastCustomer[req.body.To] = req.body.From;
  res.type('text/xml').send(twiml.toString());
});

// 4) Texts to the business number:
//    - from a customer -> forward to the owner
//    - from the owner  -> send to the last customer
//      (or to a specific one by starting with their number: "+15551234567 On our way!")
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

// Owner can see upcoming bookings: /bookings?key=YOUR_ADMIN_KEY
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

// WebSocket for the AI receptionist
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/relay' });
wss.on('connection', (ws) => handleSession(ws, { getBiz, sendSms }));

if (require.main === module) {
  server.listen(PORT, () => console.log(`Listening on ${PORT}`));
}
module.exports = { app, server, wss, lastCustomer, getBiz, sendSms };
