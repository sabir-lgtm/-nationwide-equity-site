// Vercel Serverless Function: /api/contact.js
// FIXED VERSION — relaxed validation, better logging

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    const body = req.body || {};
    console.log('Incoming submission:', JSON.stringify(body));

    const errors = [];
    const name = (body.name || '').trim();
    const phone = (body.phone || '').trim();
    const email = (body.email || '').trim();
    
    if (!name || name.length < 2) errors.push('Name is required');
    if (!phone && !email) errors.push('Either phone or email is required');
    if (email && email.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push('Invalid email format');
    }
    
    if (errors.length > 0) {
      console.log('Validation failed:', errors);
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    if (body.website && body.website.trim() !== '') {
      return res.status(200).json({ ok: true });
    }

    const now = new Date().toISOString();
    const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
    const userAgent = req.headers['user-agent'] || '';
    const nameParts = name.split(/\s+/);
    const firstName = nameParts[0] || '';
    const lastName = nameParts.slice(1).join(' ') || '';

    const ghlPayload = {
      firstName, lastName, name,
      email: email.toLowerCase(),
      phone: normalizePhone(phone),
      source: 'nationwideequity.us — Web Form',
      tags: buildTags(body),
      propertyAddress: (body.propertyAddress || '').trim(),
      situation: (body.situation || '').trim(),
      message: (body.message || '').trim(),
      timeline: (body.timeline || '').trim(),
      preferredLanguage: (body.lang || 'en').trim(),
      consentNonMarketing: !!body.consentTransactional,
      consentMarketing: !!body.consentMarketing,
      consentTimestamp: now,
      consentText_nonMarketing: 'I consent to receive non-marketing text messages from Nationwide Equity LLC about my consultation request, foreclosure case updates, document and appointment notifications, and service-related communications. Message frequency may vary, message & data rates may apply. Text HELP for assistance, reply STOP to opt out.',
      consentText_marketing: 'I consent to receive marketing text messages, about special offers, discounts, and service updates, from Nationwide Equity LLC at the phone number provided. Message frequency may vary. Message & data rates may apply. Text HELP for assistance, reply STOP to opt out.',
      campaign: (body.campaign || body.source || '').trim(),
      utm_source: (body.utm_source || '').trim(),
      utm_medium: (body.utm_medium || '').trim(),
      utm_campaign: (body.utm_campaign || '').trim(),
      referrer: (body.referrer || '').trim(),
      submissionTimestamp: now,
      submissionIP: ip,
      submissionUserAgent: userAgent
    };

    const webhookUrl = process.env.GHL_WEBHOOK_URL;
    if (!webhookUrl) {
      console.error('GHL_WEBHOOK_URL not set');
      console.log('LEAD CAPTURED (no webhook):', JSON.stringify(ghlPayload));
      return res.status(200).json({ ok: true, message: 'Received' });
    }

    console.log('Forwarding to GHL...');
    const ghlResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ghlPayload),
    });
    const responseText = await ghlResponse.text().catch(() => '');

    if (!ghlResponse.ok) {
      console.error('GHL webhook failed:', ghlResponse.status, responseText);
      return res.status(200).json({ ok: true, message: 'Received, will follow up shortly' });
    }

    console.log('GHL webhook success:', ghlResponse.status);
    return res.status(200).json({ ok: true, message: "Thanks — we'll be in touch within 24 hours." });

  } catch (err) {
    console.error('Contact API error:', err.message);
    return res.status(500).json({ 
      error: 'Server error',
      message: 'Something went wrong. Please call us directly at 832-257-3367.'
    });
  }
}

function normalizePhone(phone) {
  if (!phone) return '';
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (/^\d{10}$/.test(cleaned)) return '+1' + cleaned;
  if (/^1\d{10}$/.test(cleaned)) return '+' + cleaned;
  return cleaned;
}

function buildTags(body) {
  const tags = ['web-form', 'website-lead'];
  const s = (body.situation || '').toLowerCase();
  if (s.includes('foreclosure') || s.includes('behind')) tags.push('foreclosure');
  if (s.includes('inherit') || s.includes('heir')) tags.push('inheritance');
  if (s.includes('tax')) tags.push('tax-delinquent');
  if (s.includes('cash') || s.includes('sell')) tags.push('cash-sale');
  if (s.includes('subject') || s.includes('takeover')) tags.push('subject-to');
  if (s.includes('rehab') || s.includes('repair')) tags.push('repair-funded');
  const t = (body.timeline || '').toLowerCase();
  if (t.includes('immediate') || t.includes('urgent') || t.includes('week')) tags.push('urgent');
  if (body.lang === 'es') tags.push('spanish');
  if (body.campaign) tags.push(`campaign-${body.campaign}`);
  if (body.consentMarketing) tags.push('marketing-consent');
  if (body.consentTransactional) tags.push('sms-consent');
  return tags;
}
