#!/usr/bin/env node
// run-outreach.js — Fire outbound SMS + scheduled AI calls to a list of prospects.
//
// Usage:
//   node run-outreach.js leads.json [delay_hours]
//
// leads.json format (either works):
//   ["+19165550001", "+19165550002"]
//   [{"phone":"+19165550001"}, {"phone":"+19165550002"}]
//
// Options:
//   delay_hours  — hours before the follow-up AI call fires (default 24)
//   SERVER_URL   — env var pointing to your server (default http://localhost:3000)
//
// Example:
//   SERVER_URL=https://your-app.onrender.com node run-outreach.js leads.json 4

const https = require('https');
const http  = require('http');
const fs    = require('fs');

const leadsFile  = process.argv[2] || 'leads.json';
const delayHours = parseFloat(process.argv[3] || '24');
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';
const PAUSE_MS   = 2500; // pause between sends to avoid Twilio rate limits

if (!fs.existsSync(leadsFile)) {
  console.error(`Leads file not found: ${leadsFile}`);
  console.error('Create leads.json with an array of phone numbers and re-run.');
  process.exit(1);
}

const leads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));

function post(url, data) {
  return new Promise((resolve, reject) => {
    const body   = new URLSearchParams(data).toString();
    const parsed = new URL(url);
    const mod    = parsed.protocol === 'https:' ? https : http;
    const req    = mod.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { resolve({ raw: d }); }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  console.log('\n🚀 AI Web Tool Service — Outreach Campaign');
  console.log(`   Leads      : ${leads.length}`);
  console.log(`   Call delay : ${delayHours} hours after SMS`);
  console.log(`   Server     : ${SERVER_URL}\n`);

  let sent = 0, skipped = 0, failed = 0;

  for (const lead of leads) {
    const phone = typeof lead === 'string' ? lead : lead.phone;
    if (!phone) { console.log('  ⚠ Skipping entry with no phone:', lead); skipped++; continue; }

    try {
      const result = await post(`${SERVER_URL}/outreach`, {
        phone,
        delay_hours: delayHours,
        skip_if_contacted: 'true',
      });

      if (result.status === 'already_contacted') {
        console.log(`  ↩ ${phone} — already contacted, skipping`);
        skipped++;
      } else {
        console.log(`  ✓ ${phone} — SMS sent (sid: ${result.smsSid || 'n/a'})`);
        sent++;
      }
    } catch (e) {
      console.error(`  ✗ ${phone} — error: ${e.message}`);
      failed++;
    }

    await sleep(PAUSE_MS);
  }

  console.log(`\n📊 Done: ${sent} sent, ${skipped} skipped, ${failed} failed`);
  if (sent > 0) {
    console.log(`📞 Follow-up calls will fire in ${delayHours} hour(s).`);
    console.log(`   Keep the server running until the calls go out!\n`);
  }
})();
