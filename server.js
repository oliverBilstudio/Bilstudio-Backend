require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const nodemailer = require('nodemailer');
const fetch    = require('node-fetch');  // v2.x
const cheerio  = require('cheerio');

const app = express();

app.use(cors({ origin: process.env.ORIGIN || '*' }));
app.use(express.json());

// --- ping ---
app.get('/ping', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// --- FINN via RSS + fallback ---
app.get('/finn', async (req, res) => {
  const orgId = req.query.orgId || '4008599';
  const rssUrl = `https://www.finn.no/car/used/search.html?orgId=${encodeURIComponent(orgId)}&sort=1&rss=1`;

  try {
    let items = [];
    // 1) RSS
    const rssResp = await fetch(rssUrl, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
        'accept-language': 'nb-NO,nb;q=0.9,no;q=0.8,en-US;q=0.7,en;q=0.6',
        'accept': 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.7',
        'referer': 'https://www.finn.no/'
      }
    });

    if (rssResp.ok) {
      const xml = await rssResp.text();
      const $rss = cheerio.load(xml, { xmlMode: true });
      $rss('item').each((_, el) => {
        const $el = $rss(el);
        const title = ($el.find('title').first().text() || '').trim();
        const link = ($el.find('link').first().text() || '').trim();
        const desc = $el.find('description').first().text() || '';
        let img = '';
        try {
          const $desc = cheerio.load(desc);
          img = $desc('img').attr('src') || '';
          if (img && img.startsWith('//')) img = 'https:' + img;
        } catch (_){}
        if (title && link) items.push({ title, url: link, img, price: '' });
      });
    }

    // 2) Fallback: JSON-LD/HTML hvis RSS ikke ga noe
    if (!items.length) {
      const url = `https://www.finn.no/car/used/search.html?orgId=${encodeURIComponent(orgId)}`;
      const resp = await fetch(url, {
        headers: {
          'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36',
          'accept-language':'nb-NO,nb;q=0.9,no;q=0.8,en-US;q=0.7,en;q=0.6',
          'accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'referer':'https://www.finn.no/'
        }
      });
      const html = await resp.text();
      const $ = cheerio.load(html);
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const json = JSON.parse($(el).contents().text());
          const arr  = Array.isArray(json) ? json : [json];
          arr.forEach(obj => {
            if (obj['@type']==='ItemList' && Array.isArray(obj.itemListElement)) {
              obj.itemListElement.forEach(entry=>{
                const item = entry.item || entry;
                if (item && item['@type']==='Product') {
                  items.push({
                    title: item.name || '',
                    url: item.url  || '',
                    img: Array.isArray(item.image) ? item.image[0] : (item.image || ''),
                    price: (item.offers && item.offers.price)
                      ? `${item.offers.price} ${item.offers.priceCurrency || ''}`.trim()
                      : ''
                  });
                }
              });
            }
          });
        } catch(_){}
      });
      if (!items.length) {
        $('a').each((_, a)=>{
          const $a = $(a);
          const href = $a.attr('href') || '';
          if (!href) return;
          if (/^https?:\/\/(www\.)?finn\.no\/.+/.test(href) || href.includes('/car/')) {
            const title = $a.attr('title') || $a.find('h2,h3').first().text().trim() || $a.text().trim();
            let img = $a.find('img').attr('src') || $a.find('img').attr('data-src') || '';
            if (img && img.startsWith('//')) img = 'https:' + img;
            if (title && href) {
              items.push({
                title,
                url: href.startsWith('http') ? href : ('https://www.finn.no' + href),
                img,
                price: ''
              });
            }
          }
        });
      }
    }

    console.log('FINN result', { orgId, count: items.length });
    return res.json({ ok:true, items });
  } catch (err) {
    console.error('FINN-scrape feil', err);
    return res.status(500).json({ ok:false, error:'Scrape feilet' });
  }
});

// --- test mail ---
app.get('/test-mail', async (req, res) => {
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      logger: true,
      debug:  true
    });
    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to: process.env.MAIL_TO,
      subject: 'Test fra Bilstudio backend',
      text: 'Hvis du leser dette, funker SMTP fra Render.'
    });
    res.json({ ok:true });
  } catch (err) {
    console.error('Test-mail feil', err);
    res.status(500).json({ ok:false, error:String(err) });
  }
});

// --- contact ---
app.post('/contact', async (req, res) => {
  const { regnr, name, email, phone, message } = req.body;
  if (!regnr || !name || !email || !phone) {
    return res.status(400).json({ error:'Mangler påkrevde felt' });
  }
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      logger: true, debug:true
    });
    await transporter.sendMail({
      from: process.env.MAIL_FROM,
      to:   process.env.MAIL_TO,
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
      to:   email,
      subject: 'Vi har mottatt din henvendelse',
      text:
`Hei ${name},

Takk for at du kontaktet oss angående bil med registreringsnummer ${regnr}.
Vi ser på henvendelsen og svarer fortløpende.

Mvh
Bilstudio`
    });
    res.json({ success:true });
  } catch (err) {
    console.error('E‑postfeil', err);
    res.status(500).json({ error:'Kunne ikke sende e‑post' });
  }
});

// --- root ---
app.get('/', (req,res)=> res.send('Bilstudio server kjører.'));

// --- start ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Server kjører på port ${PORT}`));
