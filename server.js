require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const nodemailer= require('nodemailer');
const fetch     = require('node-fetch');   // v2.x
const cheerio   = require('cheerio');

const app = express();

/* -----------------------------------------------------------
   CORS – tillat Netlify (frontend). Om ORIGIN ikke er satt,
   tillat alle (*).
----------------------------------------------------------- */
const allowed = process.env.ORIGIN || '*';
app.use(cors({ origin: allowed }));
app.use(express.json());

/* -----------------------------------------------------------
   Ping (helsesjekk)
----------------------------------------------------------- */
app.get('/ping', (req, res) =>
  res.json({ ok: true, time: new Date().toISOString() })
);

/* -----------------------------------------------------------
   Hjelpefunksjoner for scraping
----------------------------------------------------------- */
function absolutize(url) {
  if (!url) return '';
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/'))  return 'https://www.finn.no' + url;
  return url;
}

function firstFromSrcset(srcset) {
  if (!srcset) return '';
  // "https://img1.jpg 1x, https://img2.jpg 2x" -> "https://img1.jpg"
  return srcset.split(',')[0].trim().split(' ')[0];
}

/* -----------------------------------------------------------
   FINN-scrape – bruker søkesiden: mobility/search/car?orgId=...
   Dette gir bare faktiske bilannonser (ikke kart / bli-kunde).
----------------------------------------------------------- */
app.get('/finn', async (req, res) => {
  const orgId = req.query.orgId || '4008599';
  const url   = `https://www.finn.no/mobility/search/car?orgId=${orgId}`;

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0 Safari/537.36',
        'Accept-Language': 'nb-NO,nb;q=0.9,no;q=0.8,en;q=0.5',
        'Cache-Control': 'no-cache'
      }
    });
    const html = await resp.text();
    const $ = cheerio.load(html);

    const items = [];
    const seen  = new Set();

    // Gå gjennom alle "kort". FINN endrer markup innimellom,
    // så vi leter bredt og filtrerer på lenker som ser ut som annonse.
    $('article, li, div').each((_, el) => {
      const $el = $(el);

      // Finn lenke som peker til en bilannonse
      let a = $el.find('a[href*="/car/"]').first();
      if (!a.length) return;

      let link = absolutize(a.attr('href'));
      if (!link || seen.has(link)) return;

      // Tittel – prøv flere varianter
      let title =
        $el.find('[data-testid="object-card-title"]').text().trim() ||
        $el.find('h3, h2').first().text().trim() ||
        a.attr('aria-label') || a.text().trim() || 'Uten tittel';

      // Bilde – kan ligge i <img> eller srcset på <source>
      let img =
        $el.find('img').attr('src') ||
        $el.find('img').attr('data-src') ||
        firstFromSrcset($el.find('source').attr('srcset'));
      img = absolutize(img);

      // Pris – prøv testid først, ellers første tekstnode med "kr"
      let price =
        $el.find('[data-testid="price"]').first().text().trim() ||
        $el.find(':contains("kr")').filter((i, e) => $(e).children().length === 0)
          .first().text().trim();

      items.push({ title, link, image: img || '', price });
      seen.add(link);
    });

    console.log('FINN scrape (search/car)', { orgId, count: items.length });
    res.json({ ok: true, items });
  } catch (err) {
    console.error('FINN scrape error', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* -----------------------------------------------------------
   Test-mail (valgfri)
----------------------------------------------------------- */
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
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* -----------------------------------------------------------
   Kontaktskjema
----------------------------------------------------------- */
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

    // Til Bilstudio
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

/* -----------------------------------------------------------
   Rot
----------------------------------------------------------- */
app.get('/', (req, res) => res.send('Bilstudio server kjører.'));

/* -----------------------------------------------------------
   Start
----------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
