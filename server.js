require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const nodemailer= require('nodemailer');
const fetch     = require('node-fetch');   // v2.x
const cheerio   = require('cheerio');

const app = express();

// CORS – tillat kun Netlify-opprinnelse (eller * hvis ORIGIN ikke satt)
app.use(cors({ origin: process.env.ORIGIN || '*' }));
app.use(express.json());

// Ping / helse
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/**
 * FINN – henter kun annonser (ikke kart) fra søkesiden
 * Eksempel: GET /finn?orgId=4008599
 */
app.get('/finn', async (req, res) => {
  const orgId = req.query.orgId || '4008599';
  const url = `https://www.finn.no/mobility/search/car?orgId=${orgId}`;

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

    // Gå gjennom alle <article>-kort
    $('article').each((_, el) => {
      const $el = $(el);

      // Plukk KUN annonselenker: /car/used/ad.html?finnkode=XXXXXX
      // (unngå /map/car/... o.l.)
      let link = $el.find('a[href*="/car/used/ad.html"]').attr('href');
      if (!link) return;                       // hopp over kort uten annonselenke
      if (link && !/^https?:\/\//.test(link)) {
        link = 'https://www.finn.no' + link;
      }

      // Tittel – prøv flere varianter
      let title =
        $el.find('h2').first().text().trim() ||
        $el.find('h3').first().text().trim() ||
        $el.find('[data-testid="title"]').first().text().trim() ||
        $el.find('[itemprop="name"]').first().text().trim() ||
        'Uten tittel';

      // Pris – forsøk å finne tekst som inneholder "kr"
      let price =
        $el.find('[data-testid="price"]').first().text().trim() ||
        $el.find('span:contains("kr")').first().text().trim();

      // Bilde – src eller srcset
      let img =
        $el.find('img').attr('src') ||
        $el.find('img').attr('data-src') ||
        $el.find('img').attr('data-original') ||
        '';

      if (!img) {
        const srcset = $el.find('img').attr('srcset') || '';
        if (srcset) {
          const last = srcset.split(',').map(s => s.trim()).pop(); // høyeste oppløsning
          if (last) img = last.split(' ')[0];
        }
      }
      if (img && img.startsWith('//')) img = 'https:' + img;

      items.push({
        title, price,
        link,                        // <– peker på selve annonsen
        image: img || ''             // kan være tom – frontend har fallback
      });
    });

    console.log('FINN scrape', { orgId, count: items.length });
    res.json({ ok: true, items });

  } catch (err) {
    console.error('FINN scrape error', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ---------------------------  KONTAKTSKJEMA  --------------------------- */
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

    // til Bilstudio
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

    // bekreftelse til kunde
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

// Rot
app.get('/', (req, res) => res.send('Bilstudio server kjører.'));

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
