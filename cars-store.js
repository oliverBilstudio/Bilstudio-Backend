// cars-store.js (CommonJS)
const fs   = require('fs');
const path = require('path');

const DATA_PATH = path.resolve(__dirname, 'data/cars.json');

function readJson() {
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf-8');
    return JSON.parse(raw || '[]');
  } catch (e) {
    return [];
  }
}

function writeJson(arr) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(arr, null, 2));
}

// Hent kun aktive biler (det er disse som skal vises på nettsiden)
function getCars() {
  return readJson().filter(c => c.active !== false);
}

// Legg til/oppdater en bil (unik på orderNo)
function upsertCar(car) {
  const cars = readJson();
  const i = cars.findIndex(c => c.orderNo === car.orderNo);
  if (i >= 0) cars[i] = { ...cars[i], ...car, active: true };
  else cars.push({ ...car, active: true });
  writeJson(cars);
}

// Sett inaktiv når bilen er solgt/slettet
function deactivateCar(orderNo) {
  const cars = readJson();
  const i = cars.findIndex(c => c.orderNo === orderNo);
  if (i >= 0) {
    cars[i].active = false;
    writeJson(cars);
  }
}

module.exports = { getCars, upsertCar, deactivateCar };
