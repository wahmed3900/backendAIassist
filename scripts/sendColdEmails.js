require('dotenv').config();
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function generateAndSendEmails() {
  const leadsPath = path.join(__dirname, '..', 'leads.json');
  if (!fs.existsSync(leadsPath)) {
    console.error('leads.json not found!');
    return;
  }

  const leads = JSON.parse(fs.readFileSync(leadsPath, 'utf8'));

  for (const lead of leads) {
    console.log(`\nGenerating email for ${lead.businessName} (${lead.ownerName})...`);

    try {
      // Prompt Claude to act as an expert cold email copywriter
      const response = await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 600,
        system: 'You are an expert B2B copywriter specializing in short, punchy, high-converting cold emails for local service businesses. Never use spammy buzzwords.',
        messages: [
          {
            role: 'user',
            content: `Write a short cold email to ${lead.ownerName}, owner of ${lead.businessName} (${lead.industry}).
            Their main challenge/pain point is: ${lead.painPoint}.
            
            Pitch our service: 
            - If it's about missed calls, pitch our AI Missed Call Text-Back & Receptionist system that books jobs 24/7.
            - If it's about websites, pitch high-converting AI Web Development & Design.
            
            Keep it under 100 words, conversational, and end with a low-friction question-based call to action.`
          }
        ]
      });

      const emailBody = response.content[0].text;
      
      console.log('--- DRAFTED EMAIL ---');
      console.log(`To: ${lead.email}`);
      console.log(emailBody);
      console.log('---------------------');

      // TODO: Integration point with Nodemailer / SendGrid / Twilio SendGrid to actually send the email
      // await sendRealEmail(lead.email, emailBody);

    } catch (err) {
      console.error(`Failed to generate email for ${lead.businessName}:`, err.message);
    }
  }
}

generateAndSendEmails();
