require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');            // <- for å hente FINN-siden
const cheerio = require('cheerio');             // <- for å parse HTML

const app = express();

// CORS – tillat kun Netlify-opprinnelse (eller * hvis ORIGIN ikke satt)
app.use(cors({ origin: process.env.ORIGIN || '*' }));
app.use(express.json());

// Helse/ping
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Enkel test av SMTP utenom skjemaet
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
      from: process.env.MAIL_FROM,
      to: process.env.MAIL_TO,
      subject: 'Test fra Bilstudio backend',
      text: 'Hvis du leser dette, funker SMTP fra Render.'
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Test-mail feil ❌', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ------------------------------------------------------------------
   /finn – henter og parser annonselisten fra FINN
   ------------------------------------------------------------------ */
const FINN_ORG_ID = process.env.FINN_ORG_ID || '4008599';
const FINN_URL = `https://www.finn.no/mobility/business?orgId=${FINN_ORG_ID}`;

// enkel minnecache (10 min)
let cache = { time: 0, data: [] };
const CACHE_MS = 10 * 60 * 1000;

app.get('/finn', async (req, res) => {
  try {
    // cache
    if (Date.now() - cache.time < CACHE_MS && cache.data.length) {
      return res.json({ items: cache.data, cached: true });
    }

    const html = await fetch(FINN_URL, {
      headers: {
        // user-agent for å få "vanlig" HTML fra FINN
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36'
      }
    }).then(r => r.text());

    const $ = cheerio.load(html);
    const items = [];

    // FINN kan endre markup. Dette fungerer pr. nå, men kan måtte tilpasses.
    $('a[href*="/car/"], a[href*="/bap/forsale/"], a[href*="/car/used"]').each((_, a) => {
      const href = $(a).attr('href');
      const url = href?.startsWith('http') ? href : `https://www.finn.no${href}`;

      const title =
        $(a).find('h3, .ads__unit__link, .sf-card__title, .ads__unit__content__title').first().text().trim() ||
        $(a).attr('aria-label') ||
        'Uten tittel';

      // finn bilde
      let img =
        $(a).find('img').attr('src') ||
        $(a).find('img').attr('data-src') ||
        $(a).find('img').attr('data-original') ||
        null;

      // finn pris
      const price =
        $(a).find('.ads__unit__content__keys .ads__unit__content__value').first().text().trim() ||
        $(a).find('[class*="price"]').first().text().trim() ||
        '';

      if (url && title) {
        items.push({ title, url, img, price });
      }
    });

    cache = { time: Date.now(), data: items };
    res.json({ items, cached: false });
  } catch (e) {
    console.error('Feil ved henting/parsing av FINN', e);
    res.json({ items: [] });
  }
});

/* ------------------ Kontakt-endepunkt (din kode) ------------------ */
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
    console.error('E‑postfeil ❌', err);
    res.status(500).json({ error: 'Kunne ikke sende e‑post' });
  }
});

// Rot
app.get('/', (req, res) => {
  res.send('Bilstudio server kjører.');
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
