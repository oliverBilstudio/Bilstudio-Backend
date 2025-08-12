require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors({ origin: process.env.ORIGIN || '*' }));
app.use(express.json());

async function fetchFromFinn(path, params = '') {
  const url = `https://cache.api.finn.no${path}${params}`;
  const resp = await fetch(url, {
    headers: {
      'X-FINN-apikey': process.env.FINN_API_KEY,
      'Accept': 'application/json'
    }
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch { }
  return { status: resp.status, ok: resp.ok, json, raw: text };
}

// === Hovedendepunkt for bilene ===
app.get('/api/cars', async (req, res) => {
  const orgId = req.query.orgId || '4008599';
  const result = await fetchFromFinn(`/iad/search/car`, `?orgId=${orgId}`);
  if (!result.ok) {
    return res.status(result.status).json({
      ok: false,
      error: `FINN API error: ${result.status}`,
      hint: result.status === 403 ? 'Sjekk at nøkkel og tilgang er aktivert.' : undefined
    });
  }
  res.json({ ok: true, data: result.json });
});

// === Debug-endepunkt som viser rårespons uansett status ===
app.get('/debug/test-car-norway', async (req, res) => {
  const orgId = req.query.orgId || '4008599';
  const result = await fetchFromFinn(`/iad/search/car-norway`, `?orgId=${orgId}`);
  res.type('text/plain').send(
    `URL: https://cache.api.finn.no/iad/search/car-norway?orgId=${orgId}\n` +
    `Status: ${result.status}\n` +
    `OK: ${result.ok}\n` +
    `JSON: ${result.json ? 'yes' : 'no'}\n\n` +
    `RAW RESPONSE:\n${result.raw}`
  );
});

// === Rot ===
app.get('/', (_req, res) => res.send('Bilstudio server kjører.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server kjører på port ${PORT}`));
