// server.js
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const fetch      = require('node-fetch'); // v2.x

const app = express();

/* ---------------------------------------------------------
   CORS – tillat Netlify-opprinnelsen (eller * hvis ikke satt)
---------------------------------------------------------- */
app.use(cors({ origin: process.env.ORIGIN || '*' }));
app.use(express.json());

/* ---------------------------------------------------------
   Helse/ping
---------------------------------------------------------- */
app.get('/ping', (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

/* ---------------------------------------------------------
   FINN API – henter biler for orgId (default 4008599)
   Frontend bruker:  GET https://<din-backend>/api/cars
---------------------------------------------------------- */
async function fetchFinnCarsFromApi(orgId, apiKey) {
  const url = `https://cache.api.finn.no/iad/search/car?orgId=${encodeURIComponent(orgId)}`;

  const resp = await fetch(url, {
    headers: {
      'X-FINN-apikey': apiKey,   // VIKTIG: riktig header
      'Accept': 'application/json'
    }
  });

  // Les body én gang (til både parsing og debug)
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignorer parse-feil */ }

  return { status: resp.status, ok: resp.ok, data: json, raw: text };
}

app.get(['/finn', '/cars', '/api/cars'], async (req, res) => {
  try {
    const orgId = req.query.orgId || '4008599';
    const apiKey = process.env.FINN_API_KEY; // sett i .env / Render env

    if (!apiKey) {
      return res.status(500).json({ ok: false, error: 'Mangler FINN_API_KEY i environment' });
    }

    const result = await fetchFinnCarsFromApi(orgId, apiKey);

    if (!result.ok) {
      return res
        .status(result.status)
        .json({
          ok: false,
          error: `FINN API error: ${result.status}`,
          hint: result.status === 403
            ? 'Sjekk X-FINN-apikey, at tilgangen er aktiv, og at /iad/search/car er åpnet for nøkkelen.'
            : undefined
        });
    }

    // Map til enkelt frontend-format
    const docs = Array.isArray(result.data?.docs) ? result.data.docs : [];
    const items = docs.map(doc => {
      const finnkode = doc.id || doc.finnkode || doc.finnCode;
      const link =
        doc.ad_link ||
        (finnkode ? `https://www.finn.no/car/used/ad.html?finnkode=${finnkode}` : '');
      const image =
        doc.image ||
        (Array.isArray(doc.images) && doc.images[0] && (doc.images[0].url || doc.images[0].image_url)) ||
        '';
      const price =
        doc.price?.amount != null
          ? `${Number(doc.price.amount).toLocaleString('no-NO')} kr`
          : (doc.price?.display || '');

      return {
        title: doc.heading || doc.title || 'Uten tittel',
        link,
        image,
        price
      };
    });

    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, count: items.length, items });
  } catch (err) {
    console.error('FINN API error', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ---------------------------------------------------------
   Debug – sjekk spesifikk search-endpoint-respons (status + snippet)
   URL: /debug/finnapi?orgId=4008599
---------------------------------------------------------- */
app.get('/debug/finnapi', async (req, res) => {
  try {
    const orgId = req.query.orgId || '4008599';
    const apiKey = process.env.FINN_API_KEY || '';
    if (!apiKey) return res.status(500).send('Mangler FINN_API_KEY');

    const r = await fetchFinnCarsFromApi(orgId, apiKey);
    const snippet = (r.raw || '').slice(0, 800);
    res
      .status(200)
      .type('text/plain')
      .send(
        `URL: https://cache.api.finn.no/iad/search/car?orgId=${orgId}\n` +
        `Status: ${r.status}\n` +
        `OK: ${r.ok}\n` +
        `JSON: ${Array.isArray(r.data?.docs) ? 'yes' : 'no'}\n\n` +
        `First 800 chars of body:\n${snippet}`
      );
  } catch (e) {
    res.status(500).type('text/plain').send(String(e));
  }
});

/* ---------------------------------------------------------
   Debug – FULL liste over collections på /iad/
   (brukes for å se om "search/car" er tilgjengelig for nøkkelen)
   URL: /debug/finnroot
---------------------------------------------------------- */
app.get('/debug/finnroot', async (_req, res) => {
  try {
    const r = await fetch('https://cache.api.finn.no/iad/', {
      headers: { 'X-FINN-apikey': process.env.FINN_API_KEY || '' }
    });
    const text = await r.text();
    // Vis HELE XML, ikke avkort
    res.status(200).type('application/xml').send(text);
  } catch (e) {
    res.status(500).type('text/plain').send(String(e));
  }
});

/* ---------------------------------------------------------
   Test‑mail – verifiser SMTP (valgfritt)
---------------------------------------------------------- */
app.get('/test-mail', async (_req, res) => {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      logger: true,
      debug: true
    });

    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.MAIL_TO,
      subject: 'Test fra Bilstudio backend',
      text: 'Hvis du leser dette, funker SMTP fra serveren.'
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ---------------------------------------------------------
   Kontakt‑skjema – sender til MAIL_TO + bekreftelse
---------------------------------------------------------- */
app.post('/contact', async (req, res) => {
  const { regnr = '', name, email, phone, message } = req.body;

  if (!name || !email || !phone) {
    return res.status(400).json({ error: 'Navn, e‑post og telefon er påkrevd' });
  }

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      logger: true,
      debug: true
    });

    const subject = regnr
      ? `Ny henvendelse via nettsiden – ${regnr}`
      : `Ny henvendelse via nettsiden`;

    // 1) Intern e‑post
    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.MAIL_TO,
      subject,
      text:
`Registreringsnummer: ${regnr || '(ikke oppgitt)'}
Navn: ${name}
E‑post: ${email}
Telefon: ${phone}
Melding: ${message || '(Ingen melding)'}`
    });

    // 2) Bekreftelse til kunde
    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: email,
      subject: 'Vi har mottatt din henvendelse',
      text:
`Hei ${name},

Takk for at du kontaktet oss${regnr ? ` angående bil med registreringsnummer ${regnr}` : ''}.
Vi ser på henvendelsen og svarer fortløpende.

Mvh
Bilstudio`
    });

    res.json({ success: true });
  } catch (err) {
    console.error('E‑postfeil', err);
    res.status(500).json({ error: 'Kunne ikke sende e‑post' });
  }
});

/* ---------------------------------------------------------
   Rot
---------------------------------------------------------- */
app.get('/', (_req, res) => res.send('Bilstudio server kjører.'));

/* ---------------------------------------------------------
   Start server
---------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
