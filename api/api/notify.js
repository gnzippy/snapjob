// api/notify.js
// Called by dashboard when owner assigns a job
// Sends WhatsApp to technician

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { to, message } = req.body;
  const WA_TOKEN = process.env.WA_TOKEN;
  const WA_PHONE_ID = process.env.WA_PHONE_ID;

  if (!to || !message) return res.status(400).json({ error: 'Missing to or message' });

  try {
    // Format number for WhatsApp (remove spaces, ensure no +)
    const phone = to.replace(/\s+/g, '').replace('+', '');

    const r = await fetch(`https://graph.facebook.com/v18.0/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phone,
        type: 'text',
        text: { body: message }
      })
    });

    const data = await r.json();
    if (!r.ok) throw new Error(data.error?.message || 'WhatsApp send failed');
    return res.status(200).json({ success: true, data });

  } catch (err) {
    console.error('Notify error:', err);
    return res.status(500).json({ error: err.message });
  }
}
