require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const fetch      = require('node-fetch'); // v2.x

const app = express();

/* ---------------------------------------------------------
   CORS – tillat Netlify-opprinnelsen (eller * hvis ikke satt)
---------------------------------------------------------- */
app.use(cors({ origin: process.env.ORIGIN || '*' }));
app.use(express.json());

/* ---------------------------------------------------------
   Helse/ping
---------------------------------------------------------- */
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

/* ---------------------------------------------------------
   Hent biler fra FINN API (orgId=4008599 som default)
---------------------------------------------------------- */
app.get(['/finn', '/cars', '/api/cars'], async (req, res) => {
  try {
    const orgId = req.query.orgId || '4008599';
    const apiKey = process.env.FINN_API_KEY || 'c7279a2f-67a5-482d-bc56-45556cd482fe';

    const url = `https://cache.api.finn.no/iad/search/car?orgId=${orgId}`;
    const resp = await fetch(url, {
      headers: { 'X-FINN-apikey': apiKey }
    });

    if (!resp.ok) {
      return res.status(resp.status).json({ ok: false, error: `FINN API error: ${resp.status}` });
    }

    const data = await resp.json();

    // Mapper til frontend-format
    const items = (data.docs || []).map(doc => {
      const link = doc.ad_link || `https://www.finn.no/car/used/ad.html?finnkode=${doc.id}`;
      const image = doc.image || (doc.images && doc.images[0] && doc.images[0].url) || '';
      const price = doc.price?.amount ? `${doc.price.amount.toLocaleString('no-NO')} kr` : '';

      return {
        title: doc.heading || doc.title,
        link,
        image,
        price
      };
    });

    res.json({ ok: true, items });
  } catch (err) {
    console.error('FINN API error', err);
    res.status(500).json({ ok: false, error: String(err) });
  }
});

/* ---------------------------------------------------------
   Test-mail (frivillig) – for å verifisere SMTP
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

/* ---------------------------------------------------------
   Kontakt-skjema – sender til MAIL_TO + bekreftelse til kunde
---------------------------------------------------------- */
app.post('/contact', async (req, res) => {
  const { regnr = '', name, email, phone, message } = req.body;

  if (!name || !email || !phone) {
    return res.status(400).json({ error: 'Navn, e-post og telefon er påkrevd' });
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

    // Intern e-post
    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.MAIL_TO,
      subject,
      text:
`Registreringsnummer: ${regnr || '(ikke oppgitt)'}
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
app.get('/', (req, res) => res.send('Bilstudio server kjører.'));

/* ---------------------------------------------------------
   Start server
---------------------------------------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
