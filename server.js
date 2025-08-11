// server.js
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const fetch      = require('node-fetch');      // v2.x
const cheerio    = require('cheerio');

const app = express();

/* ---------------------------------------------------------
   CORS – tillat kun Netlify-opprinnelse (eller * om ikke satt)
---------------------------------------------------------- */
app.use(cors({ origin: process.env.ORIGIN || '*' }));
app.use(express.json());

/* ---------------------------------------------------------
   Helse/ping
---------------------------------------------------------- */
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ---------------------------------------------------------
   /finn – hent faktiske annonser fra FINNs søkeside
   Bruker bare ad-lenker: /car/used/ad.html?finnkode=...
   Eksempel: GET /finn?orgId=4008599
---------------------------------------------------------- */
app.get('/finn', async (req, res) => {
  const orgId = req.query.orgId || '4008599';
  const url   = `https://www.finn.no/mobility/search/car?orgId=${orgId}`;

  // Hjelpere
  const absolutize = (href) => {
    if (!href) return '';
    if (href.startsWith('//')) return 'https:' + href;
    if (href.startsWith('/'))  return 'https://www.finn.no' + href;
    return href;
  };
  const firstFromSrcset = (ss) => {
    if (!ss) return '';
    return ss.split(',')[0].trim().split(' ')[0];
  };

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116 Safari/537.36',
        'Accept-Language': 'nb-NO,nb;q=0.9,no;q=0.8,en;q=0.5',
        'Cache-Control': 'no-cache'
      }
    });

    const html = await resp.text();
    const $ = cheerio.load(html);

    const items = [];
    const seen  = new Set();

    // plukk KUN annonselenker
    $('a[href*="/car/used/ad.html?finnkode="]').each((_, a) => {
      let href = $(a).attr('href');
      if (!href) return;
      href = absolutize(href);
      if (seen.has(href)) return;   // unngå duplikater
      seen.add(href);

      const $card = $(a).closest('article').length
        ? $(a).closest('article')
        : $(a).parent();

      // Tittel
      const title =
        $card.find('[data-testid="object-card-title"]').first().text().trim() ||
        $card.find('h3, h2').first().text().trim() ||
        $(a).attr('title') || $(a).text().trim() || 'Uten tittel';

      // Bilde (img/src, data-src eller <source srcset>)
      let img =
        $card.find('img').attr('src') ||
        $card.find('img').attr('data-src') ||
        firstFromSrcset($card.find('source').attr('srcset'));
      img = absolutize(img);

      // Pris – prøv data-testid=price først
      let price =
        $card.find('[data-testid="price"]').first().text().trim() ||
        $card.find(':contains("kr")')
             .filter((i, el) => $(el).children().length === 0)
             .first().text().trim();

      items.push({ title, link: href, image: img || '', price });
    });

    console.log('FINN scrape (search/car)', { orgId, count: items.length });
    res.json({ ok: true, items });
  } catch (err) {
    console.error('FINN scrape error', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ---------------------------------------------------------
   Test‑mail (frivillig) – nyttig for å sjekke SMTP
---------------------------------------------------------- */
app.get('/test-mail', async (req, res) => {
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
      from: process.env.MAIL_FROM,     // må være samme konto/domenet som SMTP_USER
      to: process.env.MAIL_TO,
      subject: 'Test fra Bilstudio backend',
      text: 'Hvis du leser dette, funker SMTP fra Render.'
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
  const { regnr, name, email, phone, message } = req.body;
  if (!regnr || !name || !email || !phone) {
    return res.status(400).json({ error: 'Mangler påkrevde felt' });
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

    // Intern e‑post
    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.MAIL_TO,
      subject: `Ny henvendelse via nettsiden - ${regnr}`,
      text:
`Registreringsnummer: ${regnr}
Navn: ${name}
E‑post: ${email}
Telefon: ${phone}
Melding: ${message || '(Ingen melding)'}`
    });

    // Bekreftelse til kunde
    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: email,
      subject: 'Vi har mottatt din henvendelse',
      text:
`Hei ${name},

Takk for at du kontaktet oss angående bil med registreringsnummer ${regnr}.
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
   Rot – enkel tekst for å bekrefte at serveren lever
---------------------------------------------------------- */
app.get('/', (req, res) => res.send('Bilstudio server kjører.'));

/* ---------------------------------------------------------
   Start server
---------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
