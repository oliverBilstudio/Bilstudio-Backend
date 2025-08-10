require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');

const app = express();

// CORS – kun Netlify-opprinnelse (eller * hvis ORIGIN ikke satt)
app.use(cors({ origin: process.env.ORIGIN || '*'}));
app.use(express.json());

// Ping-endepunkt for rask helsesjekk
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.post('/contact', async (req, res) => {
  console.log('POST /contact', req.body); // <- se hva som kommer inn

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
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      },
      logger: true, // <- logg SMTP-dialog
      debug: true   // <- mer detaljert
    });

    console.log('Sender intern e-post til', process.env.MAIL_TO);
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
    console.log('Intern e-post sendt ✅');

    console.log('Sender bekreftelse til', email);
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
    console.log('Bekreftelse sendt ✅');

    res.json({ success: true });
  } catch (err) {
    console.error('E-postfeil ❌', err);   // <- se eksakt feil fra Gmail
    res.status(500).json({ error: 'Kunne ikke sende e-post' });
  }
});

app.get('/', (req, res) => {
  res.send('Bilstudio server kjører.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
