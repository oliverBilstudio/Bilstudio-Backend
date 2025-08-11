require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const nodemailer = require('nodemailer');
const fetch    = require('node-fetch');     // v2.x
const cheerio  = require('cheerio');

const app = express();

/* CORS – tillat Netlify (eller * hvis ORIGIN ikke satt) */
app.use(cors({ origin: process.env.ORIGIN || '*' }));
app.use(express.json());

/* Ping / helse */
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* -------------------------------------------------------
   FINN /finn-cars -> henter KUN bilannonser (søkesiden)
   https://www.finn.no/mobility/search/car?orgId=4008599
-------------------------------------------------------- */
app.get('/finn-cars', async (req, res) => {
  const orgId = req.query.orgId || '4008599';
  const url   = `https://www.finn.no/mobility/search/car?orgId=${orgId}`;

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept-Language': 'nb-NO,nb;q=0.9,no;q=0.8,en;q=0.5',
        'Cache-Control': 'no-cache'
      }
    });
    const html = await resp.text();
    const $ = cheerio.load(html);

    const items = [];
    // Grep alle lenker som ser ut som annonsekort ("/car/...")
    $('a[href*="/car/"]').each((_, a) => {
      let href = $(a).attr('href') || '';
      if (!href) return;
      if (!href.startsWith('http')) href = 'https://www.finn.no' + href;

      // Gå opp til nærmeste "kort"-container
      const $card = $(a).closest('article, div');

      const textClean = s => (s || '').replace(/\s+/g, ' ').trim();

      // Tittel
      let title =
        textClean($card.find('h3,h2,[data-testid="title"],[class*="title"]').first().text()) ||
        textClean($(a).attr('title')) || 'Uten tittel';

      // Bilde
      let img =
        $card.find('img').first().attr('src') ||
        $card.find('img').first().attr('data-src') ||
        $card.find('img').first().attr('data-original') || '';
      if (img && img.startsWith('//')) img = 'https:' + img;

      // Pris, årsmodell og km – forsøk med regex på hele kortet
      const blockText = textClean($card.text());
      const priceMatch = blockText.match(/(\d[\d\s]{2,}\s?kr)/i);
      const yearMatch  = blockText.match(/(19|20)\d{2}/);
      const kmMatch    = blockText.match(/([\d\s]{1,6})\s?km/i);

      items.push({
        title,
        url: href,
        img: img || '',
        price: priceMatch ? priceMatch[1].replace(/\s+/g, ' ') : '',
        year: yearMatch ? yearMatch[0] : '',
        km: kmMatch ? kmMatch[1].replace(/\s+/g, ' ') + ' km' : ''
      });
    });

    console.log('FINN /finn-cars scrape', { orgId, count: items.length });
    res.json({ ok: true, items });
  } catch (err) {
    console.error('FINN /finn-cars error', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* -------------------------
   Kontakt-skjema (uendret)
-------------------------- */
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
    console.error('E‑postfeil', err);
    res.status(500).json({ error: 'Kunne ikke sende e‑post' });
  }
});

/* Rot */
app.get('/', (req, res) => res.send('Bilstudio server kjører.'));

/* Start */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
