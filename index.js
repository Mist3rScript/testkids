/**
 * KidShield Cloud Server
 * Production API for Parent app ↔ Kids Launcher
 */

try { require('dotenv').config(); } catch { /* optional */ }
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Db = require('./db');

const app = express();
const PORT = process.env.PORT || 3847;
const CODE_TTL = 15 * 60 * 1000;
const API_SECRET = process.env.API_SECRET || '';

const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: corsOrigin === '*' ? true : corsOrigin.split(',') }));
app.use(express.json({ limit: '2mb' }));

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function requireParent(req, res, next) {
  const token = req.headers['x-parent-token'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
  const family = Db.getFamilyByToken(token);
  if (!family) return res.status(401).json({ error: 'Invalid or missing parent token' });
  req.family = family;
  next();
}

function optionalApiSecret(req, res, next) {
  if (API_SECRET && req.headers['x-api-secret'] !== API_SECRET) {
    return res.status(403).json({ error: 'Invalid API secret' });
  }
  next();
}

app.get('/', (req, res) => {
  res.json({ name: 'KidShield API', version: '1.0.0', status: 'running' });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now(), env: process.env.NODE_ENV || 'development' });
});

app.post('/api/family/register', optionalApiSecret, (req, res) => {
  const { parentName } = req.body || {};
  const familyId = 'fam_' + uuidv4().replace(/-/g, '').slice(0, 16);
  const parentToken = 'pt_' + uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '').slice(0, 8);

  Db.createFamily({ id: familyId, parentToken, parentName: parentName || 'Parent' });
  res.json({ familyId, parentToken });
});

app.post('/api/family/verify', (req, res) => {
  const token = req.body?.parentToken || req.headers['x-parent-token'];
  const family = Db.getFamilyByToken(token);
  if (!family) return res.status(401).json({ error: 'Invalid token' });
  res.json({ ok: true, familyId: family.id, parentName: family.parentName });
});

app.post('/api/pair/create', requireParent, (req, res) => {
  Db.cleanPairings();
  const { childId, childSnapshot } = req.body || {};
  if (!childId || !childSnapshot) {
    return res.status(400).json({ error: 'Missing childId or childSnapshot' });
  }

  Db.upsertChild(req.family.id, childId, childSnapshot);

  let code;
  do { code = genCode(); } while (Db.getPairings()[code]);

  Db.addPairing(code, req.family.id, childId, Date.now() + CODE_TTL);
  res.json({ code, expiresIn: CODE_TTL, familyId: req.family.id });
});

app.post('/api/sync/push', requireParent, (req, res) => {
  const { children } = req.body || {};
  if (!Array.isArray(children)) return res.status(400).json({ error: 'children array required' });
  Db.upsertChildren(req.family.id, children);
  res.json({ ok: true, count: children.length });
});

app.post('/api/pair/join', (req, res) => {
  Db.cleanPairings();
  const { code, deviceName } = req.body || {};
  const pairing = Db.getPairings()[String(code)];

  if (!pairing || pairing.expiresAt < Date.now()) {
    return res.status(404).json({ error: 'Invalid or expired pairing code' });
  }

  const family = Db.getFamily(pairing.familyId);
  const child = family?.children?.[pairing.childId];
  if (!child) return res.status(404).json({ error: 'Child profile not found' });

  const deviceId = 'device_' + uuidv4().slice(0, 12);
  const deviceToken = 'dt_' + uuidv4().replace(/-/g, '') + Date.now().toString(36);
  const now = Date.now();

  Db.addDevice(pairing.familyId, {
    id: deviceId,
    deviceToken,
    childId: pairing.childId,
    deviceName: deviceName || 'Kid Device',
    pairedAt: now,
    lastSeen: now,
    online: true,
  });

  Db.deletePairing(String(code));

  res.json({
    deviceId,
    deviceToken,
    familyId: pairing.familyId,
    childId: pairing.childId,
    snapshot: child.snapshot,
  });
});

app.get('/api/sync/rules', (req, res) => {
  const found = Db.getDeviceByToken(req.query.deviceToken);
  if (!found) return res.status(401).json({ error: 'Invalid device token' });

  const { family, device } = found;
  Db.updateDeviceSeen(family.id, device.id);

  const child = family.children[device.childId];
  res.json({
    childId: device.childId,
    familyId: family.id,
    snapshot: child?.snapshot || null,
    updatedAt: child?.updatedAt || 0,
  });
});

app.post('/api/sync/event', (req, res) => {
  const { deviceToken, event, state } = req.body || {};
  const found = Db.getDeviceByToken(deviceToken);
  if (!found) return res.status(401).json({ error: 'Invalid device token' });

  const { family, device } = found;
  Db.updateDeviceSeen(family.id, device.id);

  if (state) Db.setLiveState(family.id, device.childId, state);

  if (event) {
    Db.addEvent(family.id, {
      id: 'evt_' + uuidv4().slice(0, 12),
      familyId: family.id,
      childId: device.childId,
      deviceId: device.id,
      type: event.type,
      time: Date.now(),
      ...event,
    });
  }

  res.json({ ok: true });
});

app.get('/api/sync/pull', requireParent, (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  const family = req.family;
  const events = Db.getEventsSince(family.id, since);

  const devices = {};
  const liveStates = {};
  const now = Date.now();

  Object.entries(family.devices || {}).forEach(([id, d]) => {
    const stale = now - d.lastSeen > 60000;
    devices[id] = {
      childId: d.childId,
      deviceName: d.deviceName,
      pairedAt: d.pairedAt,
      lastSeen: d.lastSeen,
      online: !stale,
    };
    const live = family.children[d.childId]?.liveState;
    if (live) liveStates[d.childId] = live;
  });

  res.json({ events, devices, liveStates });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`KidShield Cloud Server → http://0.0.0.0:${PORT}`);
});
