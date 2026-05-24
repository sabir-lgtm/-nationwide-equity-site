// Vercel Serverless Function: /api/contact.js
// FIXED v3 — handles both firstName/lastName AND combined name, plus address/notes aliases

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

    // Accept multiple naming conventions from form
    const firstName = (body.firstName || '').trim();
    const lastName = (body.lastName || '').trim();
    
    // Build name from any available source
    let name = (body.name || '').trim();
    if (!name && (firstName || lastName)) {
      name = `${firstName} ${lastName}`.trim();
    }
    
    const phone = (body.phone || '').trim();
    const email = (body.email || '').trim();
    
    // Aliases for property address
    const propertyAddress = (body.propertyAddress || body.address || body.property || '').trim();
    
    // Aliases for message
    const message = (body.message || body.notes || body.comments || '').trim();
    
    // Validation
    const errors = [];
    if (!name || name.length < 2) errors.push('Name is required');
    if (!phone && !email) errors.push('Either phone or email is required');
    if (email && email.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push('Invalid email format');
    }
    
    if (errors.length > 0) {
      console.log('Validation failed:', errors);
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }

    // Honeypot anti-spam
    if (body.website && body.website.trim() !== '') {
      return res.status(200).json({ ok: true });
    }

    const now = new Date().toISOString();
    const ip = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '';
    const userAgent = req.headers['user-agent'] || '';
    
    // If name has multiple words and firstName not set, split it
    let resolvedFirst = firstName;
    let resolvedLast = lastName;
    if (!resolvedFirst && name) {
      const parts = name.split(/\s+/);
      resolvedFirst = parts[0] || '';
      resolvedLast = parts.slice(1).join(' ') || '';
    }

    // Convert "on" / "true" / "1" / true to boolean true
    const toBool = (v) => {
      if (v === true) return true;
      if (typeof v === 'string') {
        const s = v.toLowerCase();
        return s === 'on' || s === 'true' || s === '1' || s === 'yes';
      }
      return false;
    };

    const ghlPayload = {
      firstName: resolvedFirst,
      lastName: resolvedLast,
      name,
      email: email.toLowerCase(),
      phone: normalizePhone(phone),
      source: 'nationwideequity.us — Web Form',
      tags: buildTags(body, toBool),
      propertyAddress,
      situation: (body.situation || '').trim(),
      message,
      timeline: (body.timeline || '').trim(),
      preferredLanguage: (body.lang || body.preferredLanguage || 'en').trim(),
      consentNonMarketing: toBool(body.consentTransactional || body.consentNonMarketing),
      consentMarketing: toBool(body.consentMarketing),
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

    console.log('GHL webhook success:', ghlResponse.status, responseText);
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

function buildTags(body, toBool) {
  const tags = ['web-form', 'website-lead'];
  const s = (body.situation || '').toLowerCase();
  if (s.includes('foreclosure') || s.includes('behind') || s.includes('mortgage')) tags.push('foreclosure');
  if (s.includes('inherit') || s.includes('heir')) tags.push('inheritance');
  if (s.includes('tax')) tags.push('tax-delinquent');
  if (s.includes('cash') || s.includes('sell')) tags.push('cash-sale');
  if (s.includes('subject') || s.includes('takeover')) tags.push('subject-to');
  if (s.includes('rehab') || s.includes('repair')) tags.push('repair-funded');
  const t = (body.timeline || '').toLowerCase();
  if (t.includes('immediate') || t.includes('urgent') || t.includes('week')) tags.push('urgent');
  if (body.lang === 'es') tags.push('spanish');
  if (body.campaign) tags.push(`campaign-${body.campaign}`);
  if (toBool(body.consentMarketing)) tags.push('marketing-consent');
  if (toBool(body.consentTransactional || body.consentNonMarketing)) tags.push('sms-consent');
  return tags;
}
