require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const nodemailer = require('nodemailer');
const fetch    = require('node-fetch');       // v2.x
const cheerio  = require('cheerio');

const app = express();

/* CORS – la Netlify-domenet ditt slippe til.
   Du kan ha ORIGIN i Render Environment, f.eks.
   ORIGIN=https://boisterous-travesseiro-bc8845.netlify.app
   Hvis ikke satt -> '*' (åpent, greit for test) */
app.use(cors({ origin: process.env.ORIGIN || '*' }));
app.use(express.json());

/* ---------------------------------------------------------
   Ping / helse
--------------------------------------------------------- */
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ---------------------------------------------------------
   /finn – henter åpne annonser for orgId fra FINN Søkeside
   Eksempel: GET /finn?orgId=4008599
--------------------------------------------------------- */
app.get('/finn', async (req, res) => {
  const orgId = req.query.orgId || '4008599';
  const url   = `https://www.finn.no/car/used/search.html?orgId=${encodeURIComponent(orgId)}`;

  try {
    const resp = await fetch(url, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
        'accept-language': 'nb-NO,nb;q=0.9,no;q=0.8,en-US;q=0.7,en;q=0.6',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'referer': 'https://www.finn.no/'
      }
    });

    if (!resp.ok) {
      console.error('FINN HTTP-feil', resp.status);
      return res.status(502).json({ ok: false, error: `FINN svarte ${resp.status}` });
    }

    const html = await resp.text();
    const $ = cheerio.load(html);

    let items = [];

    // 1) Prøv JSON-LD (application/ld+json) – her ligger ItemList med Product-elementer
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).contents().text());
        const arr = Array.isArray(json) ? json : [json];

        arr.forEach(obj => {
          if (obj['@type'] === 'ItemList' && Array.isArray(obj.itemListElement)) {
            obj.itemListElement.forEach(entry => {
              const item = entry.item || entry;
              if (item && item['@type'] === 'Product') {
                items.push({
                  title: item.name || '',
                  url: item.url || '',
                  img: Array.isArray(item.image) ? item.image[0] : (item.image || ''),
                  price: (item.offers && item.offers.price)
                          ? `${item.offers.price} ${item.offers.priceCurrency || ''}`.trim()
                          : ''
                });
              }
            });
          }
        });
      } catch (_) { /* ignorer parsefeil og prøv videre */ }
    });

    // 2) Fallback: enkel HTML-scrape hvis JSON-LD ikke ga noen
    if (!items.length) {
      $('a').each((_, a) => {
        const $a = $(a);
        const href = $a.attr('href') || '';
        if (!href) return;

        // annonser har url-er som peker til FINN-sider
        if (/^https?:\/\/(www\.)?finn\.no\/.+/.test(href) || href.includes('/car/')) {
          const title = $a.attr('title')
                      || $a.find('h2,h3').first().text().trim()
                      || $a.text().trim();

          let img = $a.find('img').attr('src') || $a.find('img').attr('data-src') || '';
          if (img && img.startsWith('//')) img = 'https:' + img;

          if (title && href) {
            items.push({
              title,
              url: href.startsWith('http') ? href : ('https://www.finn.no' + href),
              img,
              price: '' // pris er vanskeligere uten JSON-LD; vises uansett inne på FINN
            });
          }
        }
      });
    }

    console.log('FINN scrape ok', { orgId, count: items.length });
    return res.json({ ok: true, items });
  } catch (err) {
    console.error('FINN-scrape feil', err);
    return res.status(500).json({ ok: false, error: 'Scrape feilet' });
  }
});

/* ---------------------------------------------------------
   Test-mail (frivillig, for diagnose)
   GET /test-mail
--------------------------------------------------------- */
app.get('/test-mail', async (req, res) => {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false, // STARTTLS
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
    console.error('Test-mail feil', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ---------------------------------------------------------
   Kontakt-skjema
--------------------------------------------------------- */
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

    // Epost til Bilstudio
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
   Rot
--------------------------------------------------------- */
app.get('/', (req, res) => res.send('Bilstudio server kjører.'));

/* Start server */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
