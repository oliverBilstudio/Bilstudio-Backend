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
   FINN API – prøv flere søkeendepunkt i prioritert rekkefølge.
   Når Geir åpner /search/car, vil det bli valgt automatisk.
---------------------------------------------------------- */
const SEARCH_PATHS = [
  'search/car',         // ønsket (kan være stengt -> 403)
  'search/car-norway',  // fallback
  'search/car-abroad'   // ekstra fallback
];

async function fetchOne(path, orgId, apiKey) {
  const url = `https://cache.api.finn.no/iad/${path}?orgId=${encodeURIComponent(orgId)}`;
  const resp = await fetch(url, {
    headers: { 'X-FINN-apikey': apiKey, 'Accept': 'application/json' }
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  return { path, url, status: resp.status, ok: resp.ok, data: json, raw: text };
}

async function fetchFinnCarsSmart(orgId, apiKey) {
  const tried = [];
  for (const p of SEARCH_PATHS) {
    const r = await fetchOne(p, orgId, apiKey);
    tried.push({ path: r.path, status: r.status });
    if (r.ok && Array.isArray(r.data?.docs)) {
      return { winner: r.path, result: r, tried };
    }
    // 200 uten docs? prøv neste
  }
  // ingen ga 200+docs
  return { winner: null, result: null, tried };
}

function mapDocsToItems(docs) {
  return docs.map(doc => {
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
}

/* ---------------------------------------------------------
   Data til frontend: /api/cars (prøver car → car-norway → car-abroad)
---------------------------------------------------------- */
app.get(['/finn', '/cars', '/api/cars'], async (req, res) => {
  try {
    const orgId = req.query.orgId || '4008599';
    const apiKey = process.env.FINN_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ ok: false, error: 'Mangler FINN_API_KEY i environment' });
    }

    const { winner, result, tried } = await fetchFinnCarsSmart(orgId, apiKey);

    if (!winner) {
      return res.status(502).json({
        ok: false,
        error: 'Ingen FINN-endepunkt returnerte resultat.',
        tried
      });
    }

    const docs = Array.isArray(result.data?.docs) ? result.data.docs : [];
    const items = mapDocsToItems(docs);

    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, source: winner, count: items.length, items });
  } catch (err) {
    console.error('FINN API error', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ---------------------------------------------------------
   Debug – viser status for hvert endepunkt vi prøver
   URL: /debug/finnapi?orgId=4008599
---------------------------------------------------------- */
app.get('/debug/finnapi', async (req, res) => {
  try {
    const orgId = req.query.orgId || '4008599';
    const apiKey = process.env.FINN_API_KEY || '';
    if (!apiKey) return res.status(500).type('text/plain').send('Mangler FINN_API_KEY');

    let log = [];
    for (const p of SEARCH_PATHS) {
      const r = await fetchOne(p, orgId, apiKey);
      log.push(`PATH: /iad/${p}  →  Status: ${r.status}  OK: ${r.ok}  Docs: ${Array.isArray(r.data?.docs) ? r.data.docs.length : 'no'}`);
      if (r.ok && Array.isArray(r.data?.docs)) {
        log.push('');
        log.push('First 800 chars of JSON:');
        log.push(JSON.stringify(r.data).slice(0, 800));
        break;
      }
    }
    res.status(200).type('text/plain').send(log.join('\n'));
  } catch (e) {
    res.status(500).type('text/plain').send(String(e));
  }
});

/* ---------------------------------------------------------
   Debug – FULL liste over collections på /iad/
   (brukes for å se hva nøkkelen faktisk har tilgang til)
   URL: /debug/finnroot
---------------------------------------------------------- */
app.get('/debug/finnroot', async (_req, res) => {
  try {
    const r = await fetch('https://cache.api.finn.no/iad/', {
      headers: { 'X-FINN-apikey': process.env.FINN_API_KEY || '' }
    });
    const text = await r.text();
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
