// Appointment book, backed by MongoDB. Bookings survive restarts and redeploys.
// Each business sets its hours, time zone and slot length in clients.json.
const { MongoClient } = require('mongodb');
const { DateTime } = require('luxon');

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB || 'ai_receptionist';

let clientPromise = null;
let collection = null;

// Connects once and reuses the connection for every call (serverless-safe pattern).
async function getCollection() {
  if (collection) return collection;
  if (!uri) throw new Error('MONGODB_URI is not set. Add it to your .env or Render environment variables.');
  if (!clientPromise) {
    const client = new MongoClient(uri);
    clientPromise = client.connect();
  }
  const client = await clientPromise;
  const col = client.db(dbName).collection('bookings');
  await col.createIndex({ business: 1, start: 1 }, { unique: true }); // belt-and-suspenders against double-booking
  collection = col;
  return col;
}

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// All upcoming bookings for one business (or every business if none given)
async function load(businessNumber) {
  const col = await getCollection();
  const query = businessNumber ? { business: businessNumber } : {};
  return col.find(query).sort({ start: 1 }).toArray();
}

// Free slots on a date ("YYYY-MM-DD") for one business
async function freeSlots(biz, dateStr) {
  const tz = biz.timezone || 'America/New_York';
  const day = DateTime.fromISO(dateStr, { zone: tz });
  if (!day.isValid) return { error: 'Invalid date. Use YYYY-MM-DD.' };

  const hours = biz.hours?.[DAYS[day.weekday - 1]];
  if (!hours) return { date: dateStr, closed: true, slots: [] };

  const len = biz.slotMinutes || 60;
  const [oh, om] = hours[0].split(':').map(Number);
  const [ch, cm] = hours[1].split(':').map(Number);
  const open = day.set({ hour: oh, minute: om });
  const close = day.set({ hour: ch, minute: cm });
  const now = DateTime.now().setZone(tz);

  const col = await getCollection();
  const dayStart = day.startOf('day').toISO();
  const dayEnd = day.endOf('day').toISO();
  const existing = await col.find({ business: biz.twilioNumber, start: { $gte: dayStart, $lte: dayEnd } }).toArray();
  const taken = new Set(existing.map(b => b.start));

  const slots = [];
  for (let t = open; t.plus({ minutes: len }) <= close; t = t.plus({ minutes: len })) {
    if (t > now.plus({ hours: 1 }) && !taken.has(t.toISO())) slots.push(t.toFormat('HH:mm'));
  }
  return { date: dateStr, weekday: day.toFormat('cccc'), slots };
}

async function book(biz, { date, time, name, phone, service, address, notes }) {
  const tz = biz.timezone || 'America/New_York';
  const start = DateTime.fromISO(`${date}T${time}`, { zone: tz });
  if (!start.isValid) return { ok: false, error: 'Invalid date or time.' };

  const avail = await freeSlots(biz, date);
  if (!avail.slots?.includes(start.toFormat('HH:mm'))) {
    return { ok: false, error: 'That time is not available.', available: avail.slots };
  }

  const booking = {
    id: Date.now().toString(36),
    business: biz.twilioNumber,
    start: start.toISO(),
    minutes: biz.slotMinutes || 60,
    name, phone, service, address, notes,
    createdAt: new Date().toISOString(),
  };

  const col = await getCollection();
  try {
    await col.insertOne(booking);
  } catch (e) {
    // Unique index caught a race between two simultaneous bookings for the same slot
    if (e.code === 11000) return { ok: false, error: 'That time was just booked. Please pick another.' };
    throw e;
  }
  return { ok: true, booking, when: start.toFormat("cccc, LLLL d 'at' h:mm a") };
}

module.exports = { freeSlots, book, load };
