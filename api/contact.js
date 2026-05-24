// Vercel Serverless Function: /api/contact.js
// Handles contact form submissions from index.html, forwards leads to GoHighLevel
// 
// SETUP REQUIRED:
//   1. In Vercel project settings -> Environment Variables, add:
//      GHL_WEBHOOK_URL  = (paste your GoHighLevel webhook URL from Automation > Workflow > Inbound Webhook)
//   2. (Optional) GHL_LOCATION_ID if your webhook requires it
//   3. Redeploy after adding env vars

export default async function handler(req, res) {
  // CORS headers (in case the form is ever embedded on a subdomain)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    // Parse incoming form payload
    const body = req.body || {};
    
    // ---- Validation ----
    const errors = [];
    if (!body.name || typeof body.name !== 'string' || body.name.trim().length < 2) {
      errors.push('Name is required');
    }
    if (!body.phone && !body.email) {
      errors.push('Either phone or email is required');
    }
    if (body.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
      errors.push('Invalid email format');
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    // ---- Honeypot anti-spam ----
    // If a "website" field is filled, it's a bot
    if (body.website && body.website.trim() !== '') {
      // Return success to fool the bot, but don't forward
      return res.status(200).json({ ok: true });
    }

    // ---- Build GHL payload ----
    // Names are designed to map cleanly to GHL custom fields
    const now = new Date().toISOString();
    const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
    const userAgent = req.headers['user-agent'] || '';

    // Parse first/last from "name" field
    const fullName = body.name.trim();
    const nameParts = fullName.split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    const ghlPayload = {
      // Standard GHL contact fields
      firstName: firstName,
      lastName: lastName,
      email: (body.email || '').trim().toLowerCase(),
      phone: normalizePhone(body.phone || ''),
      name: fullName,
      
      // Source attribution
      source: 'nationwideequity.us — Web Form',
      tags: buildTags(body),
      
      // Custom fields — case details
      propertyAddress: (body.propertyAddress || '').trim(),
      situation: (body.situation || '').trim(),
      message: (body.message || '').trim(),
      timeline: (body.timeline || '').trim(),
      preferredLanguage: (body.lang || 'en').trim(),
      
      // Consent records (A2P compliance audit trail)
      consentNonMarketing: !!body.consentTransactional,
      consentMarketing: !!body.consentMarketing,
      consentTimestamp: now,
      consentText_nonMarketing: 'I consent to receive non-marketing text messages from Nationwide Equity LLC about my consultation request, foreclosure case updates, document and appointment notifications, and service-related communications. Message frequency may vary, message & data rates may apply. Text HELP for assistance, reply STOP to opt out.',
      consentText_marketing: 'I consent to receive marketing text messages, about special offers, discounts, and service updates, from Nationwide Equity LLC at the phone number provided. Message frequency may vary. Message & data rates may apply. Text HELP for assistance, reply STOP to opt out.',
      
      // Marketing attribution
      campaign: (body.campaign || '').trim(),
      utm_source: (body.utm_source || '').trim(),
      utm_medium: (body.utm_medium || '').trim(),
      utm_campaign: (body.utm_campaign || '').trim(),
      utm_content: (body.utm_content || '').trim(),
      utm_term: (body.utm_term || '').trim(),
      referrer: (body.referrer || '').trim(),
      
      // Metadata
      submissionTimestamp: now,
      submissionIP: ip,
      submissionUserAgent: userAgent
    };

    // ---- Forward to GoHighLevel ----
    const webhookUrl = process.env.GHL_WEBHOOK_URL;
    
    if (!webhookUrl) {
      console.error('GHL_WEBHOOK_URL environment variable not set');
      // Still return success to user so they're not blocked, but log the issue
      // Lead is captured in Vercel logs as fallback
      console.log('LEAD CAPTURED (no webhook):', JSON.stringify(ghlPayload));
      return res.status(200).json({ 
        ok: true, 
        message: 'Received',
        warning: 'Webhook not configured — lead logged but not forwarded'
      });
    }

    const ghlResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ghlPayload),
    });

    if (!ghlResponse.ok) {
      const responseText = await ghlResponse.text().catch(() => '');
      console.error('GHL webhook failed:', ghlResponse.status, responseText);
      // Still log the lead so it's not lost
      console.log('LEAD CAPTURED (webhook failed):', JSON.stringify(ghlPayload));
      // Return success to user — the lead is in our logs
      return res.status(200).json({ 
        ok: true, 
        message: 'Received, will follow up shortly'
      });
    }

    return res.status(200).json({ 
      ok: true, 
      message: 'Thanks — we\'ll be in touch within 24 hours.'
    });

  } catch (err) {
    console.error('Contact API error:', err);
    return res.status(500).json({ 
      error: 'Server error',
      message: 'Something went wrong. Please call us directly at 832-257-3367.'
    });
  }
}

// ---- Helpers ----

function normalizePhone(phone) {
  if (!phone) return '';
  // Strip everything except digits and +
  const cleaned = phone.replace(/[^\d+]/g, '');
  // Add +1 country code if it's a 10-digit US number
  if (/^\d{10}$/.test(cleaned)) {
    return '+1' + cleaned;
  }
  if (/^1\d{10}$/.test(cleaned)) {
    return '+' + cleaned;
  }
  return cleaned;
}

function buildTags(body) {
  const tags = ['web-form', 'website-lead'];
  
  // Tag by situation (helps with GHL routing)
  const situation = (body.situation || '').toLowerCase();
  if (situation.includes('foreclosure') || situation.includes('behind')) tags.push('foreclosure');
  if (situation.includes('inherit') || situation.includes('heir')) tags.push('inheritance');
  if (situation.includes('tax')) tags.push('tax-delinquent');
  if (situation.includes('cash') || situation.includes('sell')) tags.push('cash-sale');
  if (situation.includes('subject') || situation.includes('takeover')) tags.push('subject-to');
  if (situation.includes('rehab') || situation.includes('repair')) tags.push('repair-funded');
  
  // Tag by urgency
  const timeline = (body.timeline || '').toLowerCase();
  if (timeline.includes('immediate') || timeline.includes('urgent') || timeline.includes('week')) {
    tags.push('urgent');
  }
  
  // Tag by language
  if (body.lang === 'es') tags.push('spanish');
  
  // Tag by campaign
  if (body.campaign) tags.push(`campaign-${body.campaign}`);
  
  // Tag consent status
  if (body.consentMarketing) tags.push('marketing-consent');
  if (body.consentTransactional) tags.push('sms-consent');
  
  return tags;
}
