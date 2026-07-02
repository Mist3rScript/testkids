/**
 * KidShield Express app (no listen — safe for Vercel import)
 */
try { require('dotenv').config(); } catch { /* optional */ }
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const Db = require('./db');

const app = express();
const CODE_TTL = 15 * 60 * 1000;
const API_SECRET = process.env.API_SECRET || '';

const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: corsOrigin === '*' ? true : corsOrigin.split(',') }));
app.use(express.json({ limit: '2mb' }));

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function requireParent(req, res, next) {
  try {
    const token = req.headers['x-parent-token'] || req.headers.authorization?.replace(/^Bearer\s+/i, '');
    const family = await Db.getFamilyByToken(token);
    if (!family) return res.status(401).json({ error: 'Invalid or missing parent token' });
    req.family = family;
    next();
  } catch (e) {
    next(e);
  }
}

function optionalApiSecret(req, res, next) {
  if (API_SECRET && req.headers['x-api-secret'] !== API_SECRET) {
    return res.status(403).json({ error: 'Invalid API secret' });
  }
  next();
}

app.get('/', (req, res) => {
  res.json({
    name: 'KidShield API',
    version: '1.0.0',
    status: 'running',
    platform: process.env.VERCEL ? 'vercel' : 'node',
  });
});

app.get('/api/health', (req, res) => {
  const blobConfigured = Boolean(
    process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID
  );
  let blobSdkVersion = null;
  let blobHasGet = false;
  try {
    blobSdkVersion = require('./db').getBlobSdkVersion?.();
    blobHasGet = typeof require('@vercel/blob').get === 'function';
  } catch { /* */ }
  res.json({
    ok: true,
    time: Date.now(),
    env: process.env.NODE_ENV || 'development',
    platform: process.env.VERCEL ? 'vercel' : 'node',
    storage: blobConfigured ? 'blob' : (process.env.VERCEL ? 'none' : 'file'),
    blobConfigured,
    blobStoreId: process.env.BLOB_STORE_ID ? 'set' : 'missing',
    blobSdkVersion,
    blobHasGet,
  });
});

app.post('/api/family/register', optionalApiSecret, async (req, res, next) => {
  try {
    const { parentName } = req.body || {};
    const familyId = 'fam_' + uuidv4().replace(/-/g, '').slice(0, 16);
    const parentToken = 'pt_' + uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '').slice(0, 8);

    await Db.createFamily({ id: familyId, parentToken, parentName: parentName || 'Parent' });
    res.json({ familyId, parentToken });
  } catch (e) {
    next(e);
  }
});

app.post('/api/family/verify', async (req, res, next) => {
  try {
    const token = req.body?.parentToken || req.headers['x-parent-token'];
    const family = await Db.getFamilyByToken(token);
    if (!family) return res.status(401).json({ error: 'Invalid token' });
    res.json({ ok: true, familyId: family.id, parentName: family.parentName });
  } catch (e) {
    next(e);
  }
});

app.post('/api/pair/create', requireParent, async (req, res, next) => {
  try {
    await Db.cleanPairings();
    const { childId, childSnapshot } = req.body || {};
    if (!childId || !childSnapshot) {
      return res.status(400).json({ error: 'Missing childId or childSnapshot' });
    }

    await Db.upsertChild(req.family.id, childId, childSnapshot);

    let code;
    do { code = genCode(); } while (await Db.hasPairing(code));

    await Db.addPairing(code, req.family.id, childId, Date.now() + CODE_TTL);
    res.json({ code, expiresIn: CODE_TTL, familyId: req.family.id });
  } catch (e) {
    next(e);
  }
});

app.post('/api/sync/push', requireParent, async (req, res, next) => {
  try {
    const { children } = req.body || {};
    if (!Array.isArray(children)) return res.status(400).json({ error: 'children array required' });
    await Db.upsertChildren(req.family.id, children);
    res.json({ ok: true, count: children.length });
  } catch (e) {
    next(e);
  }
});

app.post('/api/pair/join', async (req, res, next) => {
  try {
    await Db.cleanPairings();
    const { code, deviceName } = req.body || {};
    const pairing = await Db.getPairing(code);

    if (!pairing || pairing.expiresAt < Date.now()) {
      return res.status(404).json({ error: 'Invalid or expired pairing code' });
    }

    const family = await Db.getFamily(pairing.familyId);
    const child = family?.children?.[pairing.childId];
    if (!child) return res.status(404).json({ error: 'Child profile not found' });

    const deviceId = 'device_' + uuidv4().slice(0, 12);
    const deviceToken = 'dt_' + uuidv4().replace(/-/g, '') + Date.now().toString(36);
    const now = Date.now();

    await Db.addDevice(pairing.familyId, {
      id: deviceId,
      deviceToken,
      childId: pairing.childId,
      deviceName: deviceName || 'Kid Device',
      pairedAt: now,
      lastSeen: now,
      online: true,
    });

    await Db.deletePairing(String(code));

    res.json({
      deviceId,
      deviceToken,
      familyId: pairing.familyId,
      childId: pairing.childId,
      snapshot: child.snapshot,
    });
  } catch (e) {
    next(e);
  }
});

app.get('/api/sync/rules', async (req, res, next) => {
  try {
    const found = await Db.getDeviceByToken(req.query.deviceToken);
    if (!found) return res.status(401).json({ error: 'Invalid device token' });

    const { family, device } = found;
    await Db.updateDeviceSeen(family.id, device.id);

    const freshFamily = await Db.getFamily(family.id);
    const child = freshFamily?.children?.[device.childId];
    res.json({
      childId: device.childId,
      familyId: family.id,
      snapshot: child?.snapshot || null,
      updatedAt: child?.updatedAt || 0,
    });
  } catch (e) {
    next(e);
  }
});

app.post('/api/sync/event', async (req, res, next) => {
  try {
    const { deviceToken, event, state } = req.body || {};
    const found = await Db.getDeviceByToken(deviceToken);
    if (!found) return res.status(401).json({ error: 'Invalid device token' });

    const { family, device } = found;
    await Db.updateDeviceSeen(family.id, device.id);

    if (state) await Db.setLiveState(family.id, device.childId, state);

    if (event) {
      await Db.addEvent(family.id, {
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
  } catch (e) {
    next(e);
  }
});

app.get('/api/sync/pull', requireParent, async (req, res, next) => {
  try {
    const since = parseInt(req.query.since || '0', 10);
    const family = await Db.getFamily(req.family.id);
    if (!family) return res.status(404).json({ error: 'Family not found' });

    const events = await Db.getEventsSince(family.id, since);

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
  } catch (e) {
    next(e);
  }
});

app.use((err, req, res, next) => {
  console.error('[api error]', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

module.exports = app;
