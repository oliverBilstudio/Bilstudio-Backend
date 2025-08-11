require('dotenv').config();
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');

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
      secure: false, // STARTTLS brukes på 587
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      logger: true,   // logg SMTP-dialog i Render Logs
      debug: true
    });

    console.log('Testmail: sender til', process.env.MAIL_TO, 'fra', process.env.MAIL_FROM);
    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.MAIL_TO,
      subject: 'Test fra Bilstudio backend',
      text: 'Hvis du leser dette, funker SMTP fra Render.'
    });
    console.log('Testmail: sendt ✅');
    res.json({ ok: true });
  } catch (err) {
    console.error('Test-mail feil ❌', err);
    res.status(500).json({ ok: false, error: String(err) });
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

    // Intern e-post til Bilstudio
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

    // Bekreftelse til kunde
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
    console.error('E-postfeil ❌', err);
    res.status(500).json({ error: 'Kunne ikke sende e-post' });
  }
});

// FINN-speiling – henter annonser for gitt orgId
app.get('/finn', async (req, res) => {
  try {
    const orgId = String(req.query.orgId || '').trim();
    if (!orgId) return res.status(400).json({ error: 'orgId mangler' });

    const url = `https://www.finn.no/mobility/business?orgId=${encodeURIComponent(orgId)}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    const html = await resp.text();

    const m = html.match(/id="__NEXT_DATA__"\s+type="application\/json">([^<]+)<\/script>/);
    let listings = [];

    function collectAds(node) {
      if (!node) return;
      if (Array.isArray(node)) return node.forEach(collectAds);
      if (typeof node === 'object') {
        const title = node.title || node.heading || node.displayName || node.adName;
        const img = node.image || node.mainImage || node.primaryImage || node.imageUrl || node.imageURL;
        const price = node.price || node.priceString || node.listPrice || node.pricing;
        const href = node.url || node.href || node.link;
        const id = node.id || node.adId || node.finnkode || node.finnCode;

        if (title && img) {
          let imageUrl = '';
          if (typeof img === 'string') {
            imageUrl = img;
          } else if (img && typeof img === 'object') {
            imageUrl = img.url || img.src || img.large || img.medium || img.small || '';
          }
          if (imageUrl && !imageUrl.startsWith('data:')) {
            if (imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
            if (imageUrl.startsWith('/')) imageUrl = 'https://www.finn.no' + imageUrl;

            let fullUrl = href || node.canonicalUrl || '';
            if (fullUrl) {
              if (fullUrl.startsWith('//')) fullUrl = 'https:' + fullUrl;
              if (fullUrl.startsWith('/')) fullUrl = 'https://www.finn.no' + fullUrl;
            }
            if (!fullUrl && id && /^\d{7,10}$/.test(String(id))) {
              fullUrl = `https://www.finn.no/car/used/ad.html?finnkode=${id}`;
            }

            let priceText = '';
            if (typeof price === 'string') priceText = price;
            else if (price && typeof price === 'object') {
              priceText = price.formatted || price.amount || price.value || '';
            }

            listings.push({
              id: id || title,
              title: String(title),
              price: priceText,
              image: imageUrl,
              url: fullUrl
            });
          }
        }

        for (const k of Object.keys(node)) collectAds(node[k]);
      }
    }

    if (m) {
      const json = JSON.parse(m[1]);
      collectAds(json);
    }

    if (!listings.length) {
      const ldMatches = [...html.matchAll(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
      for (const mm of ldMatches) {
        try {
          const ld = JSON.parse(mm[1]);
          collectAds(ld);
        } catch {}
      }
    }

    const seen = new Set();
    listings = listings.filter(ad => {
      const key = ad.title + '|' + ad.image;
      if (seen.has(key)) return false;
      seen.add(key);
      return ad.image && ad.title;
    });

    res.json({ orgId, count: listings.length, items: listings });
  } catch (e) {
    console.error('FINN-scrape-feil', e);
    res.status(500).json({ error: 'Kunne ikke hente fra FINN akkurat nå' });
  }
});

// Rot
app.get('/', (req, res) => {
  res.send('Bilstudio server kjører.');
});

// Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
