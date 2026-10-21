# Missed-Call Text-Back + AI Receptionist

One server that handles phone calls for all your client businesses:

- **Text-back:** when nobody answers, the caller gets an automatic text. Their replies go to the owner.
- **AI receptionist:** an AI answers the phone, finds out what the caller needs, checks open times, and **books the appointment**. The customer and the owner both get a text confirmation.
- **Transfers:** for emergencies, or when a caller asks for a person, the AI transfers the call to the owner.

## Modes (set per business in `clients.json`)
| `aiMode` | What happens |
|---|---|
| *(not set)* | Rings the owner. If missed → text-back |
| `"after-missed"` | Rings the owner. If missed → AI answers and books |
| `"always"` | AI answers every call |

## Test it without any accounts
```
npm install
node test.js                  # text-back
node test-ai.js                # full AI booking call (fake AI + fake MongoDB)
node test-calendar-mongo.js    # just the booking/double-booking logic
```
These tests use stand-ins for Twilio, Claude and MongoDB, so no real accounts or API keys are needed to run them.

## Go live
1. **Twilio:** buy a local number and complete the **A2P 10DLC** registration. US carriers require it before you can send texts, and approval takes a few days.
2. **Twilio Console → Voice → Settings:** accept the **Predictive and Generative AI** terms. ConversationRelay, the feature the AI receptionist uses, needs this.
3. **Anthropic:** get an API key at console.anthropic.com.
4. **MongoDB:** create a free cluster at mongodb.com/cloud/atlas (the free M0 tier is plenty), create a database user, and allow access from anywhere (0.0.0.0/0) under Network Access, since Render's IP isn't fixed on the free plan. Copy the connection string into `MONGODB_URI`.
5. **Deploy** this folder to Render or Railway (the app needs WebSockets; both support them). Set the variables from `.env.example`. `PUBLIC_URL` must be your https URL.
6. **Your Twilio number's settings:**
   - A call comes in → `https://YOUR-URL/voice` (POST)
   - A message comes in → `https://YOUR-URL/sms` (POST)
7. **Configure the business in `clients.json`:** hours, time zone, services, appointment length and prices the AI is allowed to mention.

## Seeing bookings
- Every booking gets texted to the owner.
- Full list: `https://YOUR-URL/bookings?key=YOUR_ADMIN_KEY`
- Bookings are stored in MongoDB, so they survive restarts and redeploys. Each business's slot (`business` + `start`) has a unique index, so the same appointment time can never be double-booked even if two calls land at once.

## Cost per client (rough)
- Twilio number: about $1–2/month
- Calls: Twilio voice plus ConversationRelay runs roughly $0.10 or less per minute
- AI (Claude Haiku): a few cents per call

A 3-minute call costs you roughly $0.30–0.40 all in. The website offer in this project is $100/month after a 7-day trial.

## Owner replies by text
- If the owner texts the business number, the message goes to the **last customer** who called or texted.
- To reply to a specific customer, start the text with their number: `+15551234567 On our way!`

## AI receptionist subscription website
The `public/` folder contains the customer-facing AI receptionist offer page and the Stripe Checkout integration. The offer is $100 USD per month after a 7-day trial. Checkout requires a payment method; Stripe starts the recurring subscription after the trial unless canceled.

### Stripe and Render setup before accepting customers
1. In Stripe, use a restricted secret key with permission to create Checkout Sessions and read subscriptions. Add it to Render as `STRIPE_API_KEY` (never commit it to this repository).
2. Set `PUBLIC_URL` to the deployed HTTPS origin, for example `https://your-service.onrender.com`.
3. In Stripe Workbench, add a webhook endpoint at `https://your-service.onrender.com/api/stripe/webhook` and subscribe it to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`. Set the endpoint signing secret in Render as `STRIPE_WEBHOOK_SECRET`.
4. Ensure `MONGODB_URI` is configured. The webhook stores subscription status, trial end, customer email, and phone (when supplied) in the MongoDB `subscribers` collection. New subscribers still need manual business setup in `clients.json` and phone/calendar configuration; checkout does not automatically provision a receptionist.
5. Make sure the public number in the page is staffed or can connect billing and setup requests to a person. The current demo number is `(916) 313-8648`.
6. Review the draft privacy notice and terms, add the final business identity and any required contact information, and confirm applicable tax collection obligations. Automatic tax is not enabled by this integration.

A completed Checkout page means a trial subscription exists; the signed webhook is the source used to keep local subscriber records current. Configure and verify the webhook in Stripe before advertising the checkout link.
