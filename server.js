require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

const app = express();

// CORS – tillat kun Netlify-opprinnelse (eller * hvis ORIGIN ikke satt)
app.use(cors({ origin: process.env.ORIGIN || '*' }));
app.use(express.json());

// Helse/ping
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Enkel test av SMTP
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

    console.log('Testmail: sender til', process.env.MAIL_TO, 'fra', process.env.MAIL_FROM);
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

// NYTT: FINN-henter
app.get('/finn', async (req, res) => {
  const orgId = req.query.orgId;
  if (!orgId) return res.status(400).json({ error: 'Mangler orgId' });

  try {
    const url = `https://www.finn.no/mobility/business?orgId=${orgId}`;
    const html = await fetch(url).then(r => r.text());
    const $ = cheerio.load(html);

    let cars = [];
    $('[data-testid="ads-card"]').each((i, el) => {
      const title = $(el).find('a[data-testid="ads-card-link"] h2').text().trim();
      const link = $(el).find('a[data-testid="ads-card-link"]').attr('href');
      const price = $(el).find('[data-testid="price"]').text().trim();
      const img = $(el).find('img').attr('src');
      const details = [];

      $(el).find('[data-testid="key-info-item"]').each((i, detail) => {
        details.push($(detail).text().trim());
      });

      cars.push({
        title,
        link: link ? `https://www.finn.no${link}` : '',
        price,
        img,
        details
      });
    });

    res.json(cars);
  } catch (err) {
    console.error('Feil ved henting fra FINN', err);
    res.status(500).json({ error: 'Kunne ikke hente biler' });
  }
});

// Skjema-endepunkt
app.post('/contact', async (req, res) => {
  console.log('POST /contact', req.body);

  const { regnr, name, email, phone, message } = req.body;
  if (!regnr || !name || !email || !phone) {
    console.warn('Validering feilet', req.body);
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

    // Intern e-post
    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.MAIL_TO,
      subject: `Ny henvendelse via nettsiden - ${regnr}`,
      text:
`Registreringsnummer: ${regnr}
Navn: ${name}
E-post: ${email}
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
    console.error('E-postfeil ❌', err);
    res.status(500).json({ error: 'Kunne ikke sende e-post' });
  }
});

// Rot
app.get('/', (req, res) => {
  res.send('Bilstudio server kjører.');
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
