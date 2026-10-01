// AI receptionist: talks with callers over Twilio ConversationRelay
// (Twilio turns speech into text and text into speech; this file decides what to say).
const { DateTime } = require('luxon');
const calendar = require('./calendar');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5';

// Talks to Claude. Tests can swap in a fake by passing `llm` to handleSession.
function defaultLLM() {
  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic(); // reads ANTHROPIC_API_KEY
  return (params) => anthropic.messages.create({ model: MODEL, max_tokens: 400, ...params });
}

const TOOLS = [
  {
    name: 'check_availability',
    description: 'Get open appointment times for a date.',
    input_schema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD' } },
      required: ['date'],
    },
  },
  {
    name: 'book_appointment',
    description: 'Book an appointment. Only call after the caller confirmed the time and you have their name and address.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: 'HH:mm, 24-hour' },
        name: { type: 'string' },
        service: { type: 'string' },
        address: { type: 'string' },
        notes: { type: 'string', description: 'Short description of the problem' },
      },
      required: ['date', 'time', 'name', 'service'],
    },
  },
  {
    name: 'transfer_to_human',
    description: 'Transfer the call to the owner. Use for emergencies, angry callers, or if the caller asks for a person.',
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
  {
    name: 'end_call',
    description: 'Hang up after saying goodbye.',
    input_schema: { type: 'object', properties: {} },
  },
];

function systemPrompt(biz, callerPhone) {
  const now = DateTime.now().setZone(biz.timezone || 'America/New_York');
  return `You are the friendly phone receptionist for ${biz.name}.
Today is ${now.toFormat("cccc, LLLL d, yyyy")} and the time is ${now.toFormat('h:mm a')}.
The caller's phone number is ${callerPhone}.

About the business: ${biz.about || ''}
Services: ${(biz.services || []).join(', ')}
Service area: ${biz.serviceArea || 'ask if unsure'}

Your job: understand what they need, then book an appointment.
Steps: ask what's going on, pick a day, use check_availability, offer 2 or 3 times,
get their name and service address, repeat the booking back, then book_appointment.
After booking, tell them they'll get a text confirmation, then ask if there's anything else.

Rules:
- This is a phone call. Keep every reply to 1 or 2 short sentences. No lists, no emojis, no markdown.
- Say times like "2 PM", never "14:00".
- Never make up prices, availability or policies. If you don't know, say the owner will follow up.
- Emergencies (gas smell, no heat in freezing weather, water leak, anything unsafe): use transfer_to_human.
${biz.extraInstructions || ''}`;
}

// One call = one WebSocket session
function handleSession(ws, { getBiz, sendSms, llm = null }) {
  let biz, caller, callSid;
  const messages = [];
  let busy = Promise.resolve();
  let ask; // created lazily so tests can run without an API key

  const say = (text) => ws.send(JSON.stringify({ type: 'text', token: text, last: true }));
  const end = (handoff) => ws.send(JSON.stringify({ type: 'end', handoffData: JSON.stringify(handoff) }));

  async function runTool(name, input) {
    if (name === 'check_availability') return await calendar.freeSlots(biz, input.date);
    if (name === 'book_appointment') {
      const res = await calendar.book(biz, { ...input, phone: caller });
      if (res.ok) {
        const b = res.booking;
        sendSms(biz.twilioNumber, caller,
          `${biz.name}: you're booked for ${res.when} (${b.service}). Reply here if you need to change it.`).catch(() => {});
        sendSms(biz.twilioNumber, biz.ownerPhone,
          `NEW BOOKING (AI): ${b.name} ${caller}\n${res.when}\n${b.service}\n${b.address || ''}\n${b.notes || ''}`).catch(() => {});
      }
      return res;
    }
    if (name === 'transfer_to_human') return { action: 'transfer', reason: input.reason };
    if (name === 'end_call') return { action: 'end' };
    return { error: 'unknown tool' };
  }

  async function respond(userText) {
    messages.push({ role: 'user', content: userText });
    for (let i = 0; i < 6; i++) {
      const res = await ask({ system: systemPrompt(biz, caller), tools: TOOLS, messages });
      messages.push({ role: 'assistant', content: res.content });

      const text = res.content.filter(c => c.type === 'text').map(c => c.text).join(' ').trim();
      if (text) say(text);

      const calls = res.content.filter(c => c.type === 'tool_use');
      if (!calls.length) return;

      const results = [];
      let finish = null;
      for (const c of calls) {
        const out = await runTool(c.name, c.input);
        if (out?.action) finish = out;
        results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(out) });
      }
      messages.push({ role: 'user', content: results });

      if (finish) {
        if (finish.action === 'transfer' && !text) say('One moment, let me connect you.');
        if (finish.action === 'end' && !text) say('Thanks for calling. Goodbye!');
        // Give the voice a moment to finish speaking before ending
        setTimeout(() => end({ reason: finish.action, detail: finish.reason || '' }), 2500);
        return;
      }
    }
  }

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'setup') {
      biz = getBiz(msg.to);
      caller = msg.from;
      callSid = msg.callSid;
      ask = llm || defaultLLM();
      console.log(`[AI] call ${callSid} from ${caller} to ${biz?.name}`);
      if (!biz) end({ reason: 'end' });
    } else if (msg.type === 'prompt' && msg.last !== false) {
      busy = busy.then(() => respond(msg.voicePrompt)).catch((e) => {
        console.error('[AI] error:', e.message);
        say("Sorry, I'm having trouble. Let me connect you to someone.");
        setTimeout(() => end({ reason: 'transfer', detail: 'ai error' }), 2500);
      });
    } else if (msg.type === 'interrupt') {
      // Caller talked over the AI: keep only what was actually spoken
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant' && Array.isArray(last.content)) {
        const t = last.content.find(c => c.type === 'text');
        if (t && msg.utteranceUntilInterrupt) t.text = msg.utteranceUntilInterrupt;
      }
    } else if (msg.type === 'error') {
      console.error('[AI] Twilio error:', msg.description);
    }
  });
}

module.exports = { handleSession, systemPrompt, TOOLS };
