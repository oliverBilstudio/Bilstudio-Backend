require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const fetch = require('node-fetch'); // for FINN-henting
const cheerio = require('cheerio');  // for HTML-parsing

const app = express();

// CORS – tillat kun fra Netlify (eller * hvis ORIGIN ikke satt)
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

// Skjema-endepunkt
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

/* =========================================================
   NYTT: Hent biler fra FINN
   Eksempel: /finn?orgId=4008599
========================================================= */
app.get('/finn', async (req, res) => {
  const orgId = req.query.orgId;
  if (!orgId) return res.status(400).json({ error: 'Mangler orgId' });

  try {
    const finnUrl = `https://www.finn.no/mobility/business?orgId=${orgId}`;
    const html = await fetch(finnUrl).then(r => r.text());
    const $ = cheerio.load(html);

    const cars = [];

    $('[data-testid="result-item"]').each((i, el) => {
      const title = $(el).find('[data-testid="result-title"]').text().trim();
      const price = $(el).find('[data-testid="price"]').text().trim();
      const url = $(el).find('a').attr('href');
      const image = $(el).find('img').attr('src');

      if (title && url) {
        cars.push({
          title,
          price,
          url: url.startsWith('http') ? url : `https://www.finn.no${url}`,
          image
        });
      }
    });

    res.json({ items: cars });
  } catch (err) {
    console.error('Feil ved henting fra FINN ❌', err);
    res.status(500).json({ error: 'Kunne ikke hente fra FINN' });
  }
});

// Rot
app.get('/', (req, res) => {
  res.send('Bilstudio server kjører.');
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
