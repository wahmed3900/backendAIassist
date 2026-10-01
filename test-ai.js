// Simulates an AI receptionist call with a scripted fake AI and a fake MongoDB
// collection, so this runs with no API keys and no real database.
process.env.SKIP_SIGNATURE_CHECK = 'true';

// --- fake MongoDB, injected before anything requires 'mongodb' ---
function makeFakeMongoModule() {
  const store = [];
  const col = {
    async createIndex() { return 'ok'; },
    find(query) {
      const match = (doc) => Object.entries(query).every(([k, v]) => {
        if (v && typeof v === 'object' && ('$gte' in v || '$lte' in v)) {
          if ('$gte' in v && !(doc[k] >= v.$gte)) return false;
          if ('$lte' in v && !(doc[k] <= v.$lte)) return false;
          return true;
        }
        return doc[k] === v;
      });
      const results = store.filter(match);
      return { sort() { return this; }, async toArray() { return results.slice(); } };
    },
    async insertOne(doc) {
      if (store.some(d => d.business === doc.business && d.start === doc.start)) {
        const e = new Error('duplicate key'); e.code = 11000; throw e;
      }
      store.push(doc);
      return { insertedId: doc.id };
    },
  };
  class FakeMongoClient { async connect() { return this; } db() { return { collection: () => col }; } }
  return { MongoClient: FakeMongoClient };
}
const mongoPath = require.resolve('mongodb');
require.cache[mongoPath] = { id: mongoPath, filename: mongoPath, loaded: true, exports: makeFakeMongoModule() };
process.env.MONGODB_URI = 'mongodb://fake/test';
// --- end fake MongoDB ---

const WebSocket = require('ws');
const { DateTime } = require('luxon');
const { server, wss, getBiz, sendSms } = require('./server');
const { handleSession } = require('./receptionist');
const calendar = require('./calendar');

const T = '+15550001111', C = '+15557776666';
const biz = getBiz(T);
let d = DateTime.now().setZone(biz.timezone).plus({ days: 1 });
while (d.weekday !== 2) d = d.plus({ days: 1 });          // next Tuesday
const date = d.toISODate();

let id = 0;
const tu = (name, input) => ({ type: 'tool_use', id: 't' + ++id, name, input });
const fakeLLM = async ({ messages, system }) => {
  if (!system.includes('ABC Heating')) throw new Error('bad system prompt');
  const last = messages[messages.length - 1];
  const txt = typeof last.content === 'string' ? last.content : '';
  const toolRes = Array.isArray(last.content) ? JSON.parse(last.content[0].content) : null;
  if (/AC stopped/.test(txt)) return { content: [{ type: 'text', text: 'Sorry to hear that! What day works for you?' }] };
  if (/Tuesday/.test(txt)) return { content: [tu('check_availability', { date })] };
  if (toolRes?.slots) return { content: [{ type: 'text', text: `On Tuesday I have ${toolRes.slots.slice(0,3).join(', ')}. Which works?` }] };
  if (/10/.test(txt)) return { content: [tu('book_appointment', { date, time: '10:00', name: 'John Smith', service: 'AC repair', address: '12 Oak St', notes: 'AC not cooling' })] };
  if (toolRes?.ok) return { content: [{ type: 'text', text: `You're all set for ${toolRes.when}. Anything else?` }] };
  if (/bye/.test(txt)) return { content: [{ type: 'text', text: 'Thanks for calling, goodbye!' }, tu('end_call', {})] };
  return { content: [{ type: 'text', text: '??' }] };
};

wss.removeAllListeners('connection');
wss.on('connection', (ws) => handleSession(ws, { getBiz, sendSms, llm: fakeLLM }));

server.listen(3998, async () => {
  const post = (p, b) => fetch('http://localhost:3998' + p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(b) }).then(r => r.text());
  console.log('MISSED CALL ->', await post('/call-status', { To: T, From: C, DialCallStatus: 'no-answer' }), '\n');

  const ws = new WebSocket('ws://localhost:3998/relay');
  const replies = [];
  ws.on('message', m => { const x = JSON.parse(m); replies.push(x); console.log('  AI:', x.type === 'text' ? x.token : JSON.stringify(x)); });
  await new Promise(r => ws.on('open', r));
  const send = async (o, wait = 150) => { if (o.voicePrompt) console.log('CALLER:', o.voicePrompt); ws.send(JSON.stringify(o)); await new Promise(r => setTimeout(r, wait)); };
  await send({ type: 'setup', from: C, to: T, callSid: 'CA123' });
  await send({ type: 'prompt', voicePrompt: 'Hi my AC stopped working', last: true });
  await send({ type: 'prompt', voicePrompt: 'Can you come Tuesday?', last: true });
  await send({ type: 'prompt', voicePrompt: '10 works', last: true });
  await send({ type: 'prompt', voicePrompt: 'No that is it, bye', last: true }, 2800);

  const bookings = await calendar.load(T);
  console.log('\nSAVED BOOKINGS (in Mongo):', bookings.length, bookings[0]?.start, bookings[0]?.name);
  const slots = await calendar.freeSlots(biz, date);
  console.log('10:00 still free?', slots.slots.includes('10:00'));
  const dupe = await calendar.book(biz, { date, time: '10:00', name: 'X', service: 'Y' });
  console.log('Double-book blocked?', !dupe.ok);
  console.log('Ended call?', replies.some(r => r.type === 'end'));
  console.log('\nRELAY END (transfer) ->', await post('/relay-end', { To: T, From: C, HandoffData: JSON.stringify({ reason: 'transfer', detail: 'gas smell' }) }));

  const pass = bookings.length === 1 && slots.slots.includes('10:00') === false && !dupe.ok && replies.some(r => r.type === 'end');
  console.log(pass ? '\nPASS' : '\nFAIL');
  ws.close(); server.close();
});
