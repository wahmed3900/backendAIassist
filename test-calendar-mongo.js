// Tests calendar.js's MongoDB logic against a tiny fake collection that mimics
// the handful of MongoDB methods calendar.js actually uses. This proves the
// booking/double-booking logic without needing a real database connection.
const path = require('path');

function makeFakeMongoModule() {
  const store = []; // array of booking docs, shared across calls like a real collection
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
      return {
        sort() { return this; },
        async toArray() { return results.slice(); },
      };
    },
    async insertOne(doc) {
      if (store.some(d => d.business === doc.business && d.start === doc.start)) {
        const e = new Error('duplicate key'); e.code = 11000; throw e;
      }
      store.push(doc);
      return { insertedId: doc.id };
    },
  };
  class FakeMongoClient {
    constructor() {}
    async connect() { return this; }
    db() { return { collection: () => col }; }
  }
  return { MongoClient: FakeMongoClient, _store: store };
}

// Inject the fake in place of the real 'mongodb' package before calendar.js requires it
const fake = makeFakeMongoModule();
const mongoPath = require.resolve('mongodb');
require.cache[mongoPath] = { id: mongoPath, filename: mongoPath, loaded: true, exports: fake };
process.env.MONGODB_URI = 'mongodb://fake/test';

const calendar = require('./calendar');
const { DateTime } = require('luxon');

(async () => {
  const biz = {
    twilioNumber: '+15550001111',
    timezone: 'America/Detroit',
    slotMinutes: 120,
    hours: { tue: ['08:00', '18:00'] },
  };
  let d = DateTime.now().setZone(biz.timezone).plus({ days: 1 });
  while (d.weekday !== 2) d = d.plus({ days: 1 });
  const date = d.toISODate();

  const before = await calendar.freeSlots(biz, date);
  console.log('Free slots before booking:', before.slots);

  const booked = await calendar.book(biz, { date, time: '10:00', name: 'John Smith', phone: '+1555', service: 'AC repair', address: '12 Oak St' });
  console.log('Booking result:', booked.ok, booked.when);

  const after = await calendar.freeSlots(biz, date);
  console.log('10:00 still free after booking?', after.slots.includes('10:00'));

  const dupe = await calendar.book(biz, { date, time: '10:00', name: 'Jane Doe', phone: '+1666', service: 'Furnace repair' });
  console.log('Double-booking the same slot blocked?', !dupe.ok, '-', dupe.error);

  const all = await calendar.load(biz.twilioNumber);
  console.log('Total saved bookings for this business:', all.length);

  const bad = await calendar.book(biz, { date, time: '09:00', name: 'X', service: 'Y' });
  console.log('Booking a slot that was never offered (misaligned time) blocked?', !bad.ok, '-', bad.error);

  console.log(all.length === 1 && booked.ok && !dupe.ok && !bad.ok ? '\nPASS' : '\nFAIL');
})();
