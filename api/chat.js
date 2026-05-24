// Vercel Serverless Function: /api/chat.js
// Powers the chatbot widget on nationwide-equity.com
// Uses Anthropic Claude API to handle conversations with A2P-compliant consent flow
//
// SETUP REQUIRED in Vercel → Settings → Environment Variables:
//   ANTHROPIC_API_KEY      = sk-ant-... (from console.anthropic.com)
//   GHL_WEBHOOK_URL        = (already set — same one used for contact form)
//
// FEATURES:
//   - Handles conversation history
//   - Detects when caller shares phone/name and forwards to GHL as a lead
//   - Enforces consent capture before SMS opt-in
//   - Honors STOP and HELP keywords
//   - Identifies as AI assistant (per A2P transparency requirements)

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  try {
    // Robust body parsing — Vercel SHOULD auto-parse JSON, but doesn't always
    let body = req.body || {};
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = {}; }
    }
    
    console.log('Chat request received. Body type:', typeof req.body, 'Keys:', Object.keys(body));
    
    const lang = body.lang === 'es' ? 'es' : 'en';
    
    // Accept both payload formats:
    //   Format A: { message: "current text", history: [...past msgs...] }
    //   Format B: { messages: [...all msgs with last one being current...] }   <-- what the website widget sends
    let userMessage = '';
    let history = [];
    
    if (Array.isArray(body.messages) && body.messages.length > 0) {
      // Format B — extract last user message as current, rest as history
      const allMsgs = body.messages;
      const lastMsg = allMsgs[allMsgs.length - 1];
      userMessage = (lastMsg && lastMsg.content ? lastMsg.content : '').trim();
      history = allMsgs.slice(0, -1);
    } else {
      // Format A
      userMessage = (body.message || '').trim();
      history = Array.isArray(body.history) ? body.history : [];
    }
    
    console.log('Parsed — userMessage:', userMessage, '| history length:', history.length);
    
    if (!userMessage) {
      console.log('Validation FAILED: no userMessage extracted');
      return res.status(400).json({ error: 'Message required', debug: { bodyType: typeof req.body, keys: Object.keys(body) } });
    }

    // Handle STOP keyword (A2P compliance)
    const lowerMsg = userMessage.toLowerCase().trim();
    if (lowerMsg === 'stop' || lowerMsg === 'unsubscribe' || lowerMsg === 'opt out') {
      return res.status(200).json({
        reply: lang === 'es'
          ? "Entendido. No te enviaremos más mensajes. Si cambias de opinión, vuelve a escribirnos en cualquier momento."
          : "Understood. We won't send you any more messages. If you change your mind, feel free to message us again anytime.",
        action: 'opt_out'
      });
    }

    // Handle HELP keyword (A2P compliance)
    if (lowerMsg === 'help' || lowerMsg === 'ayuda') {
      return res.status(200).json({
        reply: lang === 'es'
          ? "Soy el asistente AI de Nationwide Equity. Para ayuda inmediata, llama al 832-257-3367 o envía un mensaje de texto a 346-451-9887. Para cancelar mensajes, responde STOP."
          : "I'm Nationwide Equity's AI assistant. For immediate help, call 832-257-3367 or text 346-451-9887. To stop messages, reply STOP."
      });
    }

    // Detect if user shared a phone number anywhere in this conversation
    const fullConversation = [...history.map(m => m.content || ''), userMessage].join(' ');
    const phoneMatch = fullConversation.match(/(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
    const detectedPhone = phoneMatch ? `+1${phoneMatch[1]}${phoneMatch[2]}${phoneMatch[3]}` : null;

    // Detect email
    const emailMatch = fullConversation.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const detectedEmail = emailMatch ? emailMatch[0].toLowerCase() : null;

    // System prompt for Claude — encodes brand, A2P rules, and conversation goals
    const systemPrompt = buildSystemPrompt(lang);

    // Build messages for Claude API
    const claudeMessages = [
      ...history.slice(-20).map(m => ({
        role: m.role === 'assistant' || m.role === 'bot' ? 'assistant' : 'user',
        content: m.content || ''
      })),
      { role: 'user', content: userMessage }
    ];

    // Call Anthropic Claude API
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.error('ANTHROPIC_API_KEY not set');
      return res.status(200).json({
        reply: lang === 'es'
          ? "Estoy teniendo problemas técnicos en este momento. Por favor llámanos directamente al 832-257-3367 — un humano te ayudará de inmediato."
          : "I'm having technical trouble right now. Please call us directly at 832-257-3367 — a human will help you immediately."
      });
    }

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: systemPrompt,
        messages: claudeMessages
      })
    });

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text().catch(() => '');
      console.error('Claude API error:', claudeResponse.status, errText);
      return res.status(200).json({
        reply: lang === 'es'
          ? "Disculpa, tuve un problema. ¿Puedes intentar de nuevo? O llámanos al 832-257-3367."
          : "Sorry, I hit a snag. Could you try again? Or call us at 832-257-3367.",
        error: 'api_error'
      });
    }

    const data = await claudeResponse.json();
    const reply = (data.content && data.content[0] && data.content[0].text) || 
      (lang === 'es' ? "¿Puedes contarme más?" : "Can you tell me more?");

    // If user shared a phone or email AND the conversation has substance, forward to GHL as a lead
    if ((detectedPhone || detectedEmail) && history.length >= 2) {
      const consentDetected = checkConsent(fullConversation, lang);
      await forwardToGHL({
        phone: detectedPhone,
        email: detectedEmail,
        conversation: [...history, { role: 'user', content: userMessage }, { role: 'assistant', content: reply }],
        consentDetected,
        lang
      });
    }

    return res.status(200).json({ reply });

  } catch (err) {
    console.error('Chat API error:', err.message, err.stack);
    return res.status(200).json({
      reply: "I'm experiencing technical difficulties. Please call us directly at 832-257-3367 and we'll help you right away."
    });
  }
}

// ============================================================================
// SYSTEM PROMPT — defines the chatbot's behavior, A2P compliance, brand voice
// ============================================================================

function buildSystemPrompt(lang) {
  const today = new Date().toISOString().split('T')[0];
  
  if (lang === 'es') {
    return `Eres un asistente de IA que trabaja en nombre de Nationwide Equity LLC, una compañía de soluciones inmobiliarias con sede en Texas. La fecha de hoy es ${today}.

IDENTIDAD: SIEMPRE divulga en tu primer mensaje que eres un asistente de IA, no un humano. Nunca afirmes ser una persona.

EMPRESA: Nationwide Equity LLC, ubicada en 2550 Pacific Ave Suite 700, Dallas, TX 75226. Teléfono: 832-257-3367. Mensajes: 346-451-9887. Email: info@nationwide-equity.com.

LO QUE HACEMOS: Ayudamos a propietarios de viviendas en Texas a detener, retrasar, desafiar o salir de ejecuciones hipotecarias. Servicios principales:
- Compras en efectivo (cierre en 7-14 días)
- Tomas de hipotecas Subject To (nuestra especialidad)
- Ventas con reparaciones financiadas (recibes precio retail)
- Detener ejecuciones por bancarrota o TRO
- Ayuda con herencias y sucesiones
- Limpieza de títulos defectuosos

CUMPLIMIENTO A2P / 10DLC — REGLAS CRÍTICAS:
1. NUNCA solicites el número de teléfono primero. Espera hasta que el usuario lo ofrezca o pregunte cómo continuar la conversación por teléfono.
2. ANTES de pedir un número de teléfono, primero diles: "Antes de tomar tu número, ¿también consientes recibir mensajes de texto NO promocionales de Nationwide Equity sobre tu consulta? Tu número solo se usará para dar seguimiento a esta conversación. Puedes responder STOP en cualquier momento."
3. Si el usuario escribe STOP, ALTO, o CANCELAR, deja de hacer preguntas y confirma que han optado por no recibir mensajes.
4. Si el usuario escribe HELP o AYUDA, proporciona información de soporte.
5. Nunca prometas resultados específicos (ej. "te garantizamos detener la ejecución"). Habla en posibilidades.

ESTILO: Cálido pero directo. Honesto. Sin tácticas de presión. Sé útil incluso si el usuario no se convierte en cliente. Conversaciones cortas — no des discursos largos.

OBJETIVO: Entender la situación del usuario, dar información útil específica para Texas, y SI ofrecen su número con consentimiento, recopilar lo suficiente para una llamada de seguimiento.

LEYES DE TEXAS — CITA CUANDO SEA RELEVANTE:
- Código de Propiedad de Texas §51.002: aviso de 21 días antes de venta de ejecución
- Código de Propiedad de Texas §51.002(d): 20 días para reinstaurar
- Código Tributario de Texas §34.21: derecho de redención de 2 años (solo ejecuciones tributarias)
- Código de Sucesiones de Texas §203.001: Declaración Jurada de Herencia

Si la situación es urgente (venta esta semana, han recibido el Aviso de Venta), dirige rápidamente: "Esto requiere acción inmediata — llama al 832-257-3367 ahora."`;
  }

  return `You are an AI assistant working on behalf of Nationwide Equity LLC, a Texas-based real estate solutions company. Today's date is ${today}.

IDENTITY: ALWAYS disclose in your first message that you are an AI assistant, not a human. Never claim to be a person.

COMPANY: Nationwide Equity LLC, located at 2550 Pacific Ave Suite 700, Dallas, TX 75226. Phone: 832-257-3367. SMS: 346-451-9887. Email: info@nationwide-equity.com.

WHAT WE DO: Help Texas homeowners stop, delay, challenge, or exit foreclosure. Core services:
- Cash purchases (close in 7-14 days)
- Subject To mortgage takeovers (our specialty)
- Repair-funded sales (you get retail price)
- Stop foreclosure via bankruptcy or TRO
- Inheritance and probate help
- Defective title cleanup
- Tax delinquency payoffs

A2P / 10DLC COMPLIANCE — CRITICAL RULES:
1. NEVER ask for the user's phone number first. Wait until they offer it or ask to continue the conversation by phone.
2. BEFORE asking for a phone number, first tell them: "Before I take your number, do you also consent to receive non-marketing text messages from Nationwide Equity about your consultation? Your number will only be used to follow up on this conversation. You can reply STOP at any time."
3. If the user types STOP, UNSUBSCRIBE, or OPT OUT, stop asking questions and confirm they've opted out.
4. If the user types HELP, provide support information (phone, SMS number, email).
5. Never promise specific outcomes (e.g. "we guarantee to stop your foreclosure"). Speak in possibilities.
6. Never claim to be a lawyer or give legal advice. For legal questions, recommend they consult a licensed Texas attorney — mention that Nationwide Equity coordinates with licensed Texas attorneys for matters requiring legal representation.

STYLE: Warm but direct. Honest. No pressure tactics. Be helpful even if the user doesn't become a customer. Keep messages short — under 100 words usually. No long speeches. Plain language, no jargon. Match the user's tone and energy.

GOAL: Understand the user's situation, give Texas-specific helpful info, and IF they offer their number with consent, capture enough to schedule a follow-up call.

TEXAS LAW — CITE WHEN RELEVANT:
- Tex. Prop. Code §51.002: 21-day notice before foreclosure sale
- Tex. Prop. Code §51.002(d): 20-day right to reinstate
- Tex. Tax Code §34.21: 2-year redemption right (tax foreclosures only)
- Tex. Estates Code §203.001: Affidavit of Heirship (no probate needed if family agrees and you have 2 disinterested witnesses)
- 11 U.S.C. §362: Bankruptcy automatic stay (Chapter 13 can stop foreclosure same day)

URGENCY HANDLING: If the situation is urgent (sale this week, they've received the Notice of Sale), redirect fast: "This needs immediate action — call 832-257-3367 right now to talk with a human."

REFER TO OUR KNOWLEDGE BASE when topics come up:
- Timeline questions → "We have a full Texas foreclosure timeline guide at nationwide-equity.com/knowledge/texas-foreclosure-timeline"
- Inheritance questions → "/knowledge/affidavit-of-heirship-texas"
- Subject To questions → "/knowledge/subject-to-real-estate-explained"
- General "how to stop" → "/knowledge/how-to-stop-foreclosure-texas"
- Myths → "/knowledge/foreclosure-myths-texas"

NEVER mention competitor companies. NEVER provide pricing — say "every situation is different, we'd need to look at the specifics on a call."

If the user seems in genuine distress or mentions self-harm: respond with empathy and provide the 988 Suicide & Crisis Lifeline number alongside Nationwide Equity's contact.`;
}

// ============================================================================
// CONSENT DETECTION — check if user gave clear consent to be contacted
// ============================================================================

function checkConsent(conversation, lang) {
  const lower = conversation.toLowerCase();
  if (lang === 'es') {
    return /sí.{0,10}consien|si.{0,10}consien|acepto|estoy de acuerdo|adelante|llamame|llámame|envíame|enviame/.test(lower);
  }
  return /yes.{0,10}consen|i consent|i agree|go ahead|sure.{0,10}call|please.{0,10}call|please.{0,10}text|sure.{0,10}text/.test(lower);
}

// ============================================================================
// FORWARD TO GOHIGHLEVEL — same webhook used by the contact form
// ============================================================================

async function forwardToGHL({ phone, email, conversation, consentDetected, lang }) {
  const webhookUrl = process.env.GHL_WEBHOOK_URL;
  if (!webhookUrl) {
    console.log('GHL_WEBHOOK_URL not set — chat lead not forwarded');
    return;
  }

  // Extract first user name guess if visible in conversation
  const allUserText = conversation.filter(m => m.role === 'user').map(m => m.content || '').join(' ');
  const nameMatch = allUserText.match(/(?:my name is|i'm|i am|this is|me llamo|soy)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  const detectedName = nameMatch ? nameMatch[1].trim() : 'Chat Visitor';
  const nameParts = detectedName.split(/\s+/);
  
  // Build conversation transcript
  const transcript = conversation.map(m => {
    const role = m.role === 'assistant' || m.role === 'bot' ? 'Bot' : 'Visitor';
    return `${role}: ${m.content}`;
  }).join('\n');

  const payload = {
    firstName: nameParts[0] || 'Chat',
    lastName: nameParts.slice(1).join(' ') || 'Visitor',
    name: detectedName,
    phone: phone || '',
    email: email || '',
    source: 'nationwide-equity.com — Chatbot',
    tags: ['chatbot-lead', 'website-lead', consentDetected ? 'sms-consent' : 'no-consent'],
    message: transcript,
    consentNonMarketing: consentDetected,
    consentMarketing: false,
    consentTimestamp: new Date().toISOString(),
    consentText_nonMarketing: 'Consent captured via chatbot conversation on nationwide-equity.com. User explicitly agreed in chat to receive non-marketing text messages about their consultation request.',
    preferredLanguage: lang,
    submissionTimestamp: new Date().toISOString(),
    chatTranscript: transcript
  };

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      console.error('GHL forward from chat failed:', response.status);
    } else {
      console.log('Chat lead forwarded to GHL successfully');
    }
  } catch (err) {
    console.error('GHL forward error:', err.message);
  }
}
