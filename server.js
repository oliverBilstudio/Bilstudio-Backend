// server.js
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const fetch      = require('node-fetch'); // v2.x
const cheerio    = require('cheerio');

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
   Hjelpere for scraping fra FINN
---------------------------------------------------------- */
const absolutize = (href) => {
  if (!href) return '';
  if (href.startsWith('//')) return 'https:' + href;
  if (href.startsWith('/'))  return 'https://www.finn.no' + href;
  return href;
};
const bestFromSrcset = (ss) => {
  if (!ss) return '';
  const parts = ss.split(',').map(s => s.trim());
  const last  = parts[parts.length - 1] || '';
  return last.split(' ')[0] || '';
};

/* ---------------------------------------------------------
   Hent biler fra FINN – robust: prøv Next.js __NEXT_DATA__ først,
   fallback til DOM-scrape/regex om nødvendig
   Eksempel: GET /api/cars?orgId=4008599
---------------------------------------------------------- */
async function fetchFinnCars(orgId = '4008599') {
  const url = `https://www.finn.no/mobility/search/car?orgId=${orgId}`;

  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept-Language': 'nb-NO,nb;q=0.9,no;q=0.8,en;q=0.5',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache'
    }
  });

  const html = await resp.text();
  const $ = cheerio.load(html);

  // ---------- 1) PRIMÆR: Parse Next.js __NEXT_DATA__ ----------
  const nextDataRaw = $('#__NEXT_DATA__').first().text();
  if (nextDataRaw) {
    try {
      const nextData = JSON.parse(nextDataRaw);

      // Kandidater hvor resultater ofte ligger
      const candidates = [
        nextData?.props?.pageProps?.searchResult,
        nextData?.props?.pageProps?.result,
        nextData?.props?.pageProps?.data,
        nextData?.props?.pageProps
      ].filter(Boolean);

      // Rekursiv "graver" som finner arrays med items/docs/results
      const digItems = (node, acc = []) => {
        if (!node || typeof node !== 'object') return acc;
        if (Array.isArray(node)) { node.forEach(n => digItems(n, acc)); return acc; }
        if (node.items && Array.isArray(node.items)) acc.push(...node.items);
        if (node.results && Array.isArray(node.results)) acc.push(...node.results);
        if (node.docs && Array.isArray(node.docs)) acc.push(...node.docs);
        Object.values(node).forEach(v => digItems(v, acc));
        return acc;
      };

      let rawItems = [];
      for (const c of candidates) rawItems = digItems(c, rawItems);

      const itemsFromJson = rawItems
        .map(it => {
          const finnkode =
            it?.finnCode || it?.finnkode || it?.adId || it?.ad_id || it?.id;
          const link =
            it?.url ||
            it?.adUrl ||
            (finnkode ? `https://www.finn.no/car/used/ad.html?finnkode=${finnkode}` : null);

          const title =
            it?.title || it?.heading || it?.adTitle || it?.objectTitle || 'Uten tittel';

          const image =
            it?.image?.url ||
            it?.imageUrl ||
            it?.primaryImage?.url ||
            it?.images?.[0]?.url ||
            '';

          const priceText =
            it?.price?.display ||
            it?.price_text ||
            (it?.price?.amount != null
              ? new Intl.NumberFormat('no-NO', {
                  style: 'currency', currency: 'NOK', maximumFractionDigits: 0
                }).format(it.price.amount)
              : '') ||
            it?.adData?.price ||
            '';

          return link ? { title, link, image, price: priceText } : null;
        })
        .filter(Boolean);

      if (itemsFromJson.length > 0) {
        return itemsFromJson;
      }
    } catch {
      // fall gjennom til DOM-scrape
    }
  }

  // ---------- 2) FALLBACK: Skrap DOM (kortene)
  const items = [];
  const seen  = new Set();

  $('a[href*="/car/used/ad.html?finnkode="]').each((_, a) => {
    let link = absolutize($(a).attr('href'));
    if (!link || seen.has(link)) return;

    const $card =
      $(a).closest('article').length ? $(a).closest('article') :
      $(a).closest('li').length      ? $(a).closest('li')      :
      $(a).parent();

    let title =
      $card.find('[data-testid="object-card-title"]').first().text().trim() ||
      $card.find('h3, h2').first().text().trim() ||
      $(a).attr('title') || $(a).text().trim() || 'Uten tittel';

    let img =
      $card.find('img').first().attr('src') ||
      $card.find('img').first().attr('data-src') ||
      bestFromSrcset($card.find('source').first().attr('srcset')) || '';
    img = absolutize(img);

    let price =
      $card.find('[data-testid="price"]').first().text().trim() ||
      $card.find(':contains("kr")').filter((i, el) => $(el).children().length === 0)
           .first().text().trim() || '';

    items.push({ title, link, image: img, price });
    seen.add(link);
  });

  // ---------- 3) Siste nødløsning: regex
  if (items.length === 0) {
    const regex = /\/car\/used\/ad\.html\?finnkode=\d+/g;
    const found = new Set();
    let m;
    while ((m = regex.exec(html)) !== null) {
      const href = 'https://www.finn.no' + m[0];
      if (found.has(href) || seen.has(href)) continue;
      found.add(href);
      items.push({ title: 'Se annonse', link: href, image: '', price: '' });
    }
  }

  return items;
}

/* ---------------------------------------------------------
   API for biler – /cars og /api/cars gjør det samme
---------------------------------------------------------- */
app.get(['/cars', '/api/cars'], async (req, res) => {
  try {
    const orgId = req.query.orgId || '4008599';
    const items = await fetchFinnCars(orgId);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.json({ ok: true, items });
  } catch (err) {
    console.error('FINN scrape error', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ---------------------------------------------------------
   Debug-endepunkt – sjekk om siden har __NEXT_DATA__
---------------------------------------------------------- */
app.get('/debug/finn', async (req, res) => {
  try {
    const orgId = req.query.orgId || '4008599';
    const url = `https://www.finn.no/mobility/search/car?orgId=${orgId}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }});
    const html = await r.text();
    const hasNext = html.includes('__NEXT_DATA__');
    res.type('text/plain').send(
      `Fetched ${url}\nLength: ${html.length}\nHas __NEXT_DATA__: ${hasNext}\n\nFirst 600 chars:\n` +
      html.slice(0, 600)
    );
  } catch (e) {
    res.status(500).type('text/plain').send(String(e));
  }
});

/* ---------------------------------------------------------
   Test‑mail – verifiser SMTP
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
   Kontakt‑skjema – sender til MAIL_TO + bekreftelse til kunde
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
