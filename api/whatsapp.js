// api/whatsapp.js
// Receives WhatsApp messages and creates job cards in Supabase

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://jjxvcglxxelknlhngumd.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VERIFY_TOKEN = 'snapjob_verify_2026';

const WA_TOKEN = process.env.WA_TOKEN;
const WA_PHONE_ID = process.env.WA_PHONE_ID;

export default async function handler(req, res) {

  // --- WEBHOOK VERIFICATION (GET request from Meta) ---
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('Webhook verified');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  // --- RECEIVE MESSAGES (POST request from Meta) ---
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = req.body;
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;

    if (!messages || messages.length === 0) {
      return res.status(200).send('OK');
    }

    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const message = messages[0];
    const from = message.from; // customer phone number
    const msgType = message.type;
    const contact = value.contacts?.[0];
    const customerName = contact?.profile?.name || 'Unknown';

    // Get message content
    let content = '';
    let mediaUrl = null;

    if (msgType === 'text') {
      content = message.text.body;
    } else if (msgType === 'image' || msgType === 'document') {
      const mediaId = message[msgType].id;
      mediaUrl = await getMediaUrl(mediaId);
      content = message[msgType].caption || '[Photo received]';
    } else if (msgType === 'audio') {
      content = '[Voice note received]';
    } else {
      content = '[Message received]';
    }

    // Find which business owns this WhatsApp number
    // For now use the first business (single business mode)
    // Later: match by phone number ID
    const { data: businesses } = await sb.from('businesses').select('*').limit(1);
    if (!businesses || businesses.length === 0) {
      return res.status(200).send('No business found');
    }
    const business = businesses[0];

    // Find or create customer
    let customer = null;
    const { data: existingCustomer } = await sb.from('customers')
      .select('*')
      .eq('business_id', business.id)
      .eq('phone', from)
      .single();

    if (existingCustomer) {
      customer = existingCustomer;
    } else {
      const { data: newCustomer } = await sb.from('customers')
        .insert({ business_id: business.id, name: customerName, phone: from })
        .select().single();
      customer = newCustomer;
    }

    // Check if there's an open job for this customer
    const { data: openJob } = await sb.from('jobs')
      .select('*')
      .eq('business_id', business.id)
      .eq('customer_id', customer.id)
      .not('status', 'in', '("paid","done")')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (openJob) {
      // Append message to existing job
      await sb.from('messages').insert({
        business_id: business.id,
        job_id: openJob.id,
        customer_phone: from,
        direction: 'in',
        channel: 'whatsapp',
        content,
        media_url: mediaUrl
      });

      // If photo, attach to job
      if (mediaUrl) {
        const photos = openJob.photos || [];
        photos.push(mediaUrl);
        await sb.from('jobs').update({ photos }).eq('id', openJob.id);
      }

      // If technician says "done" or "completed"
      const lower = content.toLowerCase();
      if (lower.includes('done') || lower.includes('completed') || lower.includes('finish')) {
        await sb.from('jobs').update({ status: 'done', completed_at: new Date().toISOString() }).eq('id', openJob.id);
        await sendWhatsApp(from, `✅ Job marked as done! Your invoice will be sent shortly.`);

        // Notify owner via Make webhook
        if (business.make_webhook_url) {
          await fetch(business.make_webhook_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'job_done',
              customer: customer.name,
              phone: from,
              job_id: openJob.id
            })
          }).catch(() => {});
        }
        return res.status(200).send('OK');
      }

      // If customer says "accepted" or "1"
      if (lower === 'accepted' || lower === '1' || lower.includes('accept')) {
        await sb.from('jobs').update({ status: 'in_progress' }).eq('id', openJob.id);
        await sendWhatsApp(from, `✅ Got it! Job confirmed. See you at ${openJob.address || 'the location'}.`);
        return res.status(200).send('OK');
      }

    } else {
      // New enquiry — create job card
      const { data: newJob } = await sb.from('jobs').insert({
        business_id: business.id,
        customer_id: customer.id,
        title: customerName,
        description: content,
        source: 'whatsapp',
        status: 'new'
      }).select().single();

      // Save message
      await sb.from('messages').insert({
        business_id: business.id,
        job_id: newJob.id,
        customer_phone: from,
        direction: 'in',
        channel: 'whatsapp',
        content,
        media_url: mediaUrl
      });

      // Auto-reply to customer
      await sendWhatsApp(from,
        `Hi ${customerName}! 👋 Thanks for reaching out to ${business.name || 'us'}.\n\nWe've received your message and will confirm your appointment shortly.\n\nOperating hours: ${business.hours || '9am–8pm daily'}`
      );

      // Notify owner via Make webhook
      if (business.make_webhook_url) {
        await fetch(business.make_webhook_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'new_enquiry',
            name: customerName,
            phone: from,
            message: content,
            job_id: newJob.id
          })
        }).catch(() => {});
      }
    }

    return res.status(200).send('OK');

  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(200).send('OK'); // Always return 200 to Meta
  }
}

// Send WhatsApp message
async function sendWhatsApp(to, text) {
  await fetch(`https://graph.facebook.com/v18.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    })
  });
}

// Get media URL from Meta
async function getMediaUrl(mediaId) {
  try {
    const r = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
      headers: { 'Authorization': `Bearer ${WA_TOKEN}` }
    });
    const data = await r.json();
    return data.url || null;
  } catch {
    return null;
  }
}
