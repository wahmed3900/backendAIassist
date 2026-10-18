// outreach.js — Outbound SMS + AI call prospecting for AI Web Tool Service
// Uses MongoDB for contacted tracking (replaces outreach-log.json which resets on Render restarts)

const { MongoClient } = require('mongodb');

const MONGO_URI = process.env.MONGODB_URI;
let _db = null;

async function getDb() {
  if (_db) return _db;
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  _db = client.db(); // uses DB name from the URI
  // Ensure unique index so we never double-insert
  await _db.collection('outreach_log').createIndex({ phone: 1 }, { unique: true });
  return _db;
}

// Have we already texted this number?
async function alreadyContacted(toPhone) {
  const db = await getDb();
  const record = await db.collection('outreach_log').findOne({ phone: toPhone });
  return !!(record && record.sms_sent_at);
}

// Send an outbound SMS pitch
async function smsProspect(client, fromNumber, toPhone, bizName) {
  const body =
    `Hi! I'm Waqas from ${bizName}. We help local businesses never miss a lead — ` +
    `AI answers your missed calls and texts customers back automatically. ` +
    `We also do professional website redesigns. Reply YES for a free demo!`;

  const msg = await client.messages.create({ from: fromNumber, to: toPhone, body });

  const db = await getDb();
  await db.collection('outreach_log').updateOne(
    { phone: toPhone },
    { $set: { sms_sent_at: new Date().toISOString(), sms_sid: msg.sid } },
    { upsert: true }
  );

  return msg.sid;
}

// Initiate an outbound AI call
async function callProspect(client, fromNumber, toPhone, publicUrl) {
  const call = await client.calls.create({
    from: fromNumber,
    to: toPhone,
    url: `${publicUrl}/outreach-twiml`,
    statusCallback: `${publicUrl}/outreach-status`,
    statusCallbackMethod: 'POST',
  });

  const db = await getDb();
  await db.collection('outreach_log').updateOne(
    { phone: toPhone },
    { $set: { call_started_at: new Date().toISOString(), call_sid: call.sid } },
    { upsert: true }
  );

  return call.sid;
}

// Load full log (used by /outreach-log route in server.js)
async function loadLog() {
  const db = await getDb();
  const records = await db.collection('outreach_log').find({}).toArray();
  // Return in same shape as the old JSON file so server.js doesn't break
  const log = {};
  for (const r of records) {
    log[r.phone] = {
      sms_sent_at: r.sms_sent_at,
      sms_sid: r.sms_sid,
      call_started_at: r.call_started_at,
      call_sid: r.call_sid,
    };
  }
  return log;
}

module.exports = { smsProspect, callProspect, alreadyContacted, loadLog, getDb };
