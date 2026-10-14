// outreach.js — Outbound SMS + AI call prospecting for AI Web Tool Service
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'outreach-log.json');

function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch { return {}; }
}

function saveLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// Have we already texted this number?
function alreadyContacted(toPhone) {
  const log = loadLog();
  return !!(log[toPhone] && log[toPhone].sms_sent_at);
}

// Send an outbound SMS pitch
async function smsProspect(client, fromNumber, toPhone, bizName) {
  const body =
    `Hi! I'm Waqas from ${bizName}. We help local businesses never miss a lead — ` +
    `AI answers your missed calls and texts customers back automatically. ` +
    `We also do professional website redesigns. Reply YES for a free demo!`;

  const msg = await client.messages.create({ from: fromNumber, to: toPhone, body });

  const log = loadLog();
  log[toPhone] = log[toPhone] || {};
  log[toPhone].sms_sent_at = new Date().toISOString();
  log[toPhone].sms_sid = msg.sid;
  saveLog(log);

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

  const log = loadLog();
  log[toPhone] = log[toPhone] || {};
  log[toPhone].call_started_at = new Date().toISOString();
  log[toPhone].call_sid = call.sid;
  saveLog(log);

  return call.sid;
}

module.exports = { smsProspect, callProspect, alreadyContacted, loadLog, saveLog };
