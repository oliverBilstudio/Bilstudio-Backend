// server.js
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const fetch      = require('node-fetch'); // v2.x
const { XMLParser } = require('fast-xml-parser');

const app = express();

/* ---------------------------------------------------------
   CORS & JSON
---------------------------------------------------------- */
app.use(cors({ origin: process.env.ORIGIN || '*' }));
app.use(express.json());

/* ---------------------------------------------------------
   Helse/ping
---------------------------------------------------------- */
app.get('/ping', (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

/* =========================================================
   FINN API – JSON først (/iad/search/car), fall tilbake til
   XML/Atom (/iad/search/car-norway) hvis 403/ikke tilgjengelig.
========================================================= */

// --- Hjelpere ---
function mapDocsToItems(docs = []) {
  return docs.map(doc => {
    const finnkode = doc.id || doc.finnkode || doc.finnCode;
    const link =
      doc.ad_link ||
      (finnkode ? `https://www.finn.no/${finnkode}` : '') || // noen feeds bruker kort URL
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

function extractPriceFromText(txt) {
  if (!txt) return '';
  // Fanger f.eks: "699 000 kr", "699000,-"
  const m = String(txt).match(/([\d\s]{2,})\s?(kr|,-)/i);
  if (!m) return '';
  const num = m[1].replace(/[^\d]/g, '');
  if (!num) return '';
  return `${Number(num).toLocaleString('no-NO')} kr`;
}

function mapAtomEntryToItem(entry) {
  // Tittel
  const title = entry?.title?.['#text'] || entry?.title || 'Uten tittel';

  // Lenker
  const links = Array.isArray(entry?.link) ? entry.link : entry?.link ? [entry.link] : [];
  const altLink = links.find(l => (l.rel || '').toLowerCase() === 'alternate') || links[0] || {};
  const link = altLink?.href || '';

  // Bilde (media:content eller enclosure)
  let image = '';
  const media = entry?.['media:content'] || entry?.['media:group']?.['media:content'];
  if (media) {
    image = Array.isArray(media) ? (media[0]?.url || '') : (media.url || '');
  }
  if (!image) {
    const enclosure = links.find(l => (l.rel || '').toLowerCase() === 'enclosure' && /^image\//i.test(l.type || ''));
    if (enclosure) image = enclosure.href || '';
  }

  // Pris – FINN legger hovedpris typisk i finn:adata/finn:price name="main" value="659999"
  let price = '';
  const adata = entry?.['finn:adata'] || entry?.['f:adData'] || entry?.['f:ad-data'];
  // saml alle price-noder vi kan finne:
  let priceNodes = [];
  if (adata?.['finn:price']) {
    priceNodes = Array.isArray(adata['finn:price']) ? adata['finn:price'] : [adata['finn:price']];
  } else if (entry?.['finn:price']) {
    priceNodes = Array.isArray(entry['finn:price']) ? entry['finn:price'] : [entry['finn:price']];
  }

  const mainPrice = priceNodes.find(p => (p?.name || '').toLowerCase() === 'main' && p?.value);
  if (mainPrice?.value != null) {
    price = `${Number(mainPrice.value).toLocaleString('no-NO')} kr`;
  }

  // fallback til tekstfelt/summary
  if (!price) {
    const priceField = entry?.['f:price'] || adata?.price;
    if (typeof priceField === 'string') {
      price = extractPriceFromText(priceField);
    } else if (priceField?.amount != null) {
      price = `${Number(priceField.amount).toLocaleString('no-NO')} kr`;
    } else {
      const summary = entry?.summary?.['#text'] || entry?.summary || '';
      price = extractPriceFromText(summary);
    }
  }

  return { title, link, image, price };
}

// --- Kall JSON-varianten ---
async function fetchJsonSearch(orgId, apiKey) {
  const url = `https://cache.api.finn.no/iad/search/car?orgId=${encodeURIComponent(orgId)}`;
  const resp = await fetch(url, {
    headers: { 'X-FINN-apikey': apiKey, 'Accept': 'application/json' }
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { url, status: resp.status, ok: resp.ok, json, raw: text };
}

// --- Kall XML/Atom-varianten ---
async function fetchAtomSearch(orgId, apiKey) {
  const url = `https://cache.api.finn.no/iad/search/car-norway?orgId=${encodeURIComponent(orgId)}`;
  const resp = await fetch(url, {
    headers: {
      'X-FINN-apikey': apiKey,
      'Accept': 'application/atom+xml, application/xml;q=0.9, */*;q=0.8'
    }
  });
  const xml = await resp.text();
  if (!resp.ok) return { url, status: resp.status, ok: false, items: [], raw: xml };

  // parse XML → JS
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    textNodeName: '#text',
  });
  let feed;
  try { feed = parser.parse(xml); } catch { return { url, status: 500, ok: false, items: [], raw: xml }; }

  // Atom feed → entries kan ligge under feed.entry
  const entries = feed?.feed?.entry
    ? (Array.isArray(feed.feed.entry) ? feed.feed.entry : [feed.feed.entry])
    : [];

  const items = entries.map(mapAtomEntryToItem).filter(it => it.link);
  return { url, status: resp.status, ok: true, items, raw: xml };
}

/* --- Hoved-API til frontenden --- */
app.get(['/finn', '/cars', '/api/cars'], async (req, res) => {
  try {
    const orgId = req.query.orgId || process.env.FINN_ORG_ID || '4008599';
    const apiKey = process.env.FINN_API_KEY;
    if (!apiKey) return res.status(500).json({ ok: false, error: 'Mangler FINN_API_KEY i environment' });

    // 1) Prøv JSON (search/car)
    const jsonRes = await fetchJsonSearch(orgId, apiKey);
    if (jsonRes.ok && Array.isArray(jsonRes.json?.docs)) {
      const items = mapDocsToItems(jsonRes.json.docs);
      return res.json({ ok: true, source: 'search/car (json)', count: items.length, items });
    }

    // 2) Fallback: Atom (search/car-norway)
    const atomRes = await fetchAtomSearch(orgId, apiKey);
    if (atomRes.ok) {
      return res.json({ ok: true, source: 'search/car-norway (atom)', count: atomRes.items.length, items: atomRes.items });
    }

    // 3) Feil – ingen traff
    return res.status(jsonRes.status || atomRes.status || 502).json({
      ok: false,
      error: 'FINN API søk feilet',
      jsonStatus: jsonRes.status,
      atomStatus: atomRes.status,
      hint: jsonRes.status === 403 ? 'search/car er ikke åpnet for nøkkelen (be FINN åpne)' :
            atomRes.status === 406 ? 'car-norway svarer XML; vi ba om XML men fikk 406 – kontakt FINN hvis dette vedvarer' : undefined
    });
  } catch (err) {
    console.error('FINN API error', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* --- Debug: JSON-søk logg --- */
app.get('/debug/finnapi', async (req, res) => {
  try {
    const orgId = req.query.orgId || process.env.FINN_ORG_ID || '4008599';
    const apiKey = process.env.FINN_API_KEY || '';
    if (!apiKey) return res.status(500).type('text/plain').send('Mangler FINN_API_KEY');

    const r = await fetchJsonSearch(orgId, apiKey);
    res
      .status(200)
      .type('text/plain')
      .send(
        `URL: ${r.url}\nStatus: ${r.status}\nOK: ${r.ok}\n` +
        `Has docs: ${Array.isArray(r.json?.docs) ? r.json.docs.length : 'no'}\n\n` +
        `First 800 chars:\n${(r.raw || '').slice(0,800)}`
      );
  } catch (e) {
    res.status(500).type('text/plain').send(String(e));
  }
});

/* --- Debug: Atom-søk logg --- */
app.get('/debug/finnatom', async (req, res) => {
  try {
    const orgId = req.query.orgId || process.env.FINN_ORG_ID || '4008599';
    const apiKey = process.env.FINN_API_KEY || '';
    if (!apiKey) return res.status(500).type('text/plain').send('Mangler FINN_API_KEY');

    const r = await fetchAtomSearch(orgId, apiKey);
    res
      .status(200)
      .type('text/plain')
      .send(
        `URL: ${r.url}\nStatus: ${r.status}\nOK: ${r.ok}\nItems: ${r.items?.length || 0}\n\n` +
        `First 800 chars of XML:\n${(r.raw || '').slice(0,800)}`
      );
  } catch (e) {
    res.status(500).type('text/plain').send(String(e));
  }
});

/* ---------------------------------------------------------
   Test-mail – verifiser SMTP (valgfritt)
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

   const CONTACT_TO = 'post@bil-studio.no';  // ← Ny linje
await transporter.sendMail({
  from: process.env.MAIL_FROM,
  to: CONTACT_TO,              // ← Hardkodet, ikke mulig å få feil
  subject,
  text: ...
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ---------------------------------------------------------
   Kontakt-skjema – sender til MAIL_TO + bekreftelse
   (Telefon er påkrevd i hovedskjema, men IKKE for lånekalkulator)
---------------------------------------------------------- */
app.post('/contact', async (req, res) => {
  const { regnr = '', name, email, phone, message } = req.body;

  const isFromLoanCalc = typeof message === 'string' && /lånekalkulator/i.test(message);

  if (!name || !email) {
    return res.status(400).json({ error: 'Navn og e-post er påkrevd' });
  }
  if (!isFromLoanCalc && !phone) {
    return res.status(400).json({ error: 'Telefon er påkrevd' });
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

    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.MAIL_TO,
      subject,
      text:
`Registreringsnummer: ${regnr || '(ikke oppgitt)'}
Navn: ${name}
E-post: ${email}
Telefon: ${phone || '(ikke oppgitt)'}
Melding: ${message || '(Ingen melding)'}`
    });

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
    console.error('E-postfeil', err);
    res.status(500).json({ error: 'Kunne ikke sende e-post' });
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
