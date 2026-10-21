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

// Read one prospect's outreach state.
async function getContact(toPhone) {
  const db = await getDb();
  return db.collection('outreach_log').findOne({ phone: toPhone });
}

// Have we already texted this number?
async function alreadyContacted(toPhone) {
  const record = await getContact(toPhone);
  return !!(record && record.sms_sent_at);
}

// Persist the follow-up call so a process restart cannot discard its schedule.
async function scheduleCall(toPhone, delayHours) {
  const db = await getDb();
  const callDueAt = new Date(Date.now() + Number(delayHours) * 60 * 60 * 1000);
  await db.collection('outreach_log').updateOne(
    { phone: toPhone },
    {
      $set: {
        call_due_at: callDueAt,
        call_status: 'scheduled',
        call_attempts: 0,
      },
      $unset: { call_lease_until: '', call_last_error: '' },
    }
  );
  return callDueAt;
}

// Atomically claim one due call. Expired leases are reclaimed after a crash.
async function claimDueCall() {
  const db = await getDb();
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 5 * 60 * 1000);
  const result = await db.collection('outreach_log').findOneAndUpdate(
    {
      call_due_at: { $lte: now },
      $or: [
        { call_status: 'scheduled' },
        { call_status: 'processing', call_lease_until: { $lte: now } },
      ],
    },
    {
      $set: { call_status: 'processing', call_lease_until: leaseUntil },
      $inc: { call_attempts: 1 },
    },
    { sort: { call_due_at: 1 }, returnDocument: 'after' }
  );
  if (!result) return null;
  return Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
}

// Retry a failed provider request with bounded backoff; stop after five attempts.
async function retryCall(toPhone, attempts, error) {
  const db = await getDb();
  const failed = attempts >= 5;
  const backoffMinutes = Math.min(60, 2 ** Math.max(0, attempts - 1));
  const update = failed
    ? {
        $set: { call_status: 'failed', call_last_error: String(error?.message || error) },
        $unset: { call_lease_until: '' },
      }
    : {
        $set: {
          call_status: 'scheduled',
          call_due_at: new Date(Date.now() + backoffMinutes * 60 * 1000),
          call_last_error: String(error?.message || error),
        },
        $unset: { call_lease_until: '' },
      };
  await db.collection('outreach_log').updateOne({ phone: toPhone }, update);
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
    {
      $set: {
        call_started_at: new Date().toISOString(),
        call_sid: call.sid,
        call_status: 'started',
      },
      $unset: { call_lease_until: '' },
    },
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
      call_status: r.call_status,
      call_due_at: r.call_due_at,
      call_attempts: r.call_attempts || 0,
      call_last_error: r.call_last_error,
    };
  }
  return log;
}

module.exports = {
  smsProspect,
  callProspect,
  alreadyContacted,
  getContact,
  scheduleCall,
  claimDueCall,
  retryCall,
  loadLog,
  getDb,
};
