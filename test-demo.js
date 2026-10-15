// Demo-line test: scripted fake AI + fake MongoDB, no API keys needed.
// Checks that the role-play booking saves nothing and the discovery call is really booked.
process.env.SKIP_SIGNATURE_CHECK = 'true';

const store = [];
const col = {
  async createIndex() {},
  find(q) {
    const res = store.filter(d => d.business === q.business &&
      (!q.start || (d.start >= q.start.$gte && d.start <= q.start.$lte)));
    return { sort() { return this; }, async toArray() { return res.slice(); } };
  },
  async insertOne(doc) { store.push(doc); },
};
const mongoPath = require.resolve('mongodb');
require.cache[mongoPath] = { id: mongoPath, filename: mongoPath, loaded: true,
  exports: { MongoClient: class { async connect() { return this; } db() { return { collection: () => col }; } } } };
process.env.MONGODB_URI = 'mongodb://fake/test';

const WebSocket = require('ws');
const { DateTime } = require('luxon');
const { server, wss, getBiz } = require('./server');
const { handleSession } = require('./receptionist');

const T = '+19163138648', C = '+15557776666';
const biz = getBiz(T);
let d = DateTime.now().setZone(biz.timezone).plus({ days: 1 });
while (d.weekday !== 3) d = d.plus({ days: 1 }); // next Wednesday
const date = d.toISODate();

const sms = [];
const fakeSms = async (from, to, body) => sms.push({ to, body });

let id = 0, sawDemoTool = false;
const tu = (name, input) => ({ type: 'tool_use', id: 't' + ++id, name, input });
const fakeLLM = async ({ messages, system, tools }) => {
  if (!system.includes('PART 1, DEMO')) throw new Error('demo prompt not used');
  sawDemoTool = tools.some(t => t.name === 'demo_booking');
  const last = messages[messages.length - 1];
  const txt = typeof last.content === 'string' ? last.content : '';
  const r = Array.isArray(last.content) ? JSON.parse(last.content[0].content) : null;
  if (/plumbing/.test(txt)) return { content: [{ type: 'text', text: "Great, pretend you're a customer calling Sacramento Plumbing Co. Go ahead." }] };
  if (/pipe burst/.test(txt)) return { content: [tu('demo_booking', { when: 'today at 3 PM', name: 'Mike', service: 'burst pipe' })] };
  if (r?.demo) return { content: [{ type: 'text', text: "You're booked for 3 PM. Okay, stepping out of the demo. Want a quick call with Waqas?" }] };
  if (/Wednesday/.test(txt)) return { content: [tu('check_availability', { date })] };
  if (r?.slots) return { content: [{ type: 'text', text: `I have ${r.slots.slice(0, 2).join(' or ')}.` }] };
  if (/10/.test(txt)) return { content: [tu('book_appointment', { date, time: '10:00', name: 'Mike', service: 'Discovery call', address: 'Mike Plumbing', notes: 'plumber' })] };
  if (r?.ok) return { content: [{ type: 'text', text: `Booked ${r.when}. Bye!` }, tu('end_call', {})] };
  return { content: [{ type: 'text', text: '??' }] };
};

wss.removeAllListeners('connection');
wss.on('connection', ws => handleSession(ws, { getBiz, sendSms: fakeSms, llm: fakeLLM }));

server.listen(3997, async () => {
  const voice = await fetch('http://localhost:3997/voice', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: T, From: C }) }).then(r => r.text());
  const answersWithAI = voice.includes('ConversationRelay') && !voice.includes('<Dial');
  console.log('Answers straight to AI?', answersWithAI);

  const ws = new WebSocket('ws://localhost:3997/relay');
  const replies = [];
  ws.on('message', m => { const x = JSON.parse(m); replies.push(x); if (x.type === 'text') console.log('  AI:', x.token); });
  await new Promise(r => ws.on('open', r));
  const send = async (o, wait = 150) => { if (o.voicePrompt) console.log('CALLER:', o.voicePrompt); ws.send(JSON.stringify(o)); await new Promise(r => setTimeout(r, wait)); };
  await send({ type: 'setup', from: C, to: T, callSid: 'CA1' });
  await send({ type: 'prompt', voicePrompt: 'I run a plumbing company', last: true });
  await send({ type: 'prompt', voicePrompt: 'Hi, a pipe burst in my kitchen', last: true });
  const afterDemo = store.length;
  await send({ type: 'prompt', voicePrompt: 'Sure, Wednesday works', last: true });
  await send({ type: 'prompt', voicePrompt: '10 AM', last: true }, 2800);

  const checks = {
    answersWithAI,
    demoToolOffered: sawDemoTool,
    demoSavedNothing: afterDemo === 0,
    discoveryCallSaved: store.length === 1 && store[0].service === 'Discovery call',
    ownerTexted: sms.some(s => s.to === biz.ownerPhone && /Discovery call/.test(s.body)),
    callEnded: replies.some(r => r.type === 'end'),
  };
  console.log(checks);
  console.log(Object.values(checks).every(Boolean) ? 'PASS' : 'FAIL');
  ws.close(); server.close();
});
