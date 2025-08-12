// cars-api.js (CommonJS)
const express = require('express');
const { getCars, upsertCar, deactivateCar } = require('./cars-store');

const r = express.Router();

// GET /api/cars  →  brukersiden henter denne
r.get('/', (_req, res) => {
  res.json(getCars());
});

module.exports = r;
