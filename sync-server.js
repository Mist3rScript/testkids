/**
 * KidShield Sync Server
 * Links parent dashboard ↔ child device over local network.
 * Run: node server/sync-server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3847;
const DATA_FILE = path.join(__dirname, 'sync-data.json');
const CODE_TTL = 15 * 60 * 1000;

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) { /* fresh start */ }
  return { families: {}, pairings: {} };
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let db = loadData();

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function genCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function genId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function cleanExpiredPairings() {
  const now = Date.now();
  Object.keys(db.pairings).forEach(code => {
    if (db.pairings[code].expiresAt < now) delete db.pairings[code];
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    return json(res, 200, { ok: true });
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    // ---- Health ----
    if (req.method === 'GET' && url.pathname === '/api/health') {
      return json(res, 200, { ok: true, time: Date.now() });
    }

    // ---- Parent: create pairing code ----
    if (req.method === 'POST' && url.pathname === '/api/pair/create') {
      cleanExpiredPairings();
      const body = await readBody(req);
      const { familyId, childId, childSnapshot } = body;
      if (!familyId || !childId || !childSnapshot) {
        return json(res, 400, { error: 'Missing familyId, childId or childSnapshot' });
      }

      if (!db.families[familyId]) {
        db.families[familyId] = { children: {}, events: [], devices: {} };
      }

      db.families[familyId].children[childId] = {
        snapshot: childSnapshot,
        updatedAt: Date.now(),
      };

      let code;
      do { code = genCode(); } while (db.pairings[code]);

      db.pairings[code] = {
        familyId,
        childId,
        expiresAt: Date.now() + CODE_TTL,
      };

      saveData(db);
      return json(res, 200, { code, expiresIn: CODE_TTL });
    }

    // ---- Parent: push updated rules ----
    if (req.method === 'POST' && url.pathname === '/api/sync/push') {
      const body = await readBody(req);
      const { familyId, children } = body;
      if (!familyId || !children) {
        return json(res, 400, { error: 'Missing familyId or children' });
      }

      if (!db.families[familyId]) {
        db.families[familyId] = { children: {}, events: [], devices: {} };
      }

      children.forEach(c => {
        db.families[familyId].children[c.id] = {
          snapshot: c,
          updatedAt: Date.now(),
        };
      });

      saveData(db);
      return json(res, 200, { ok: true });
    }

    // ---- Child: join with pairing code ----
    if (req.method === 'POST' && url.pathname === '/api/pair/join') {
      cleanExpiredPairings();
      const body = await readBody(req);
      const { code, deviceName } = body;
      const pairing = db.pairings[String(code)];

      if (!pairing || pairing.expiresAt < Date.now()) {
        return json(res, 404, { error: 'Invalid or expired pairing code' });
      }

      const family = db.families[pairing.familyId];
      if (!family?.children?.[pairing.childId]) {
        return json(res, 404, { error: 'Child profile not found' });
      }

      const deviceId = genId('device');
      const deviceToken = genId('token');

      family.devices[deviceId] = {
        deviceToken,
        childId: pairing.childId,
        deviceName: deviceName || 'Child Device',
        pairedAt: Date.now(),
        lastSeen: Date.now(),
        online: true,
      };

      delete db.pairings[String(code)];
      saveData(db);

      return json(res, 200, {
        deviceId,
        deviceToken,
        familyId: pairing.familyId,
        childId: pairing.childId,
        snapshot: family.children[pairing.childId].snapshot,
      });
    }

    // ---- Child: get latest rules ----
    if (req.method === 'GET' && url.pathname === '/api/sync/rules') {
      const deviceToken = url.searchParams.get('deviceToken');
      const found = findDevice(deviceToken);
      if (!found) return json(res, 401, { error: 'Invalid device token' });

      const { family, device, familyId } = found;
      device.lastSeen = Date.now();
      device.online = true;
      saveData(db);

      const childData = family.children[device.childId];
      return json(res, 200, {
        childId: device.childId,
        familyId,
        snapshot: childData?.snapshot || null,
        updatedAt: childData?.updatedAt || 0,
      });
    }

    // ---- Child: send event / state ----
    if (req.method === 'POST' && url.pathname === '/api/sync/event') {
      const body = await readBody(req);
      const { deviceToken, event, state } = body;
      const found = findDevice(deviceToken);
      if (!found) return json(res, 401, { error: 'Invalid device token' });

      const { family, device, familyId } = found;
      device.lastSeen = Date.now();
      device.online = true;

      if (state) {
        family.children[device.childId] = family.children[device.childId] || {};
        family.children[device.childId].liveState = state;
        family.children[device.childId].liveUpdatedAt = Date.now();
      }

      if (event) {
        family.events.unshift({
          id: genId('evt'),
          familyId,
          childId: device.childId,
          deviceId: device.deviceId,
          ...event,
          time: Date.now(),
        });
        family.events = family.events.slice(0, 200);
      }

      saveData(db);
      return json(res, 200, { ok: true });
    }

    // ---- Parent: pull events + live states ----
    if (req.method === 'GET' && url.pathname === '/api/sync/pull') {
      const familyId = url.searchParams.get('familyId');
      const since = parseInt(url.searchParams.get('since') || '0', 10);

      if (!familyId || !db.families[familyId]) {
        return json(res, 200, { events: [], devices: {}, liveStates: {} });
      }

      const family = db.families[familyId];
      const events = (family.events || []).filter(e => e.time > since);

      const devices = {};
      const liveStates = {};
      Object.entries(family.devices || {}).forEach(([id, d]) => {
        const stale = Date.now() - d.lastSeen > 60000;
        devices[id] = { ...d, online: !stale && d.online, deviceToken: undefined };
        if (family.children[d.childId]?.liveState) {
          liveStates[d.childId] = family.children[d.childId].liveState;
        }
      });

      return json(res, 200, { events, devices, liveStates });
    }

    return json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: err.message });
  }
});

function findDevice(deviceToken) {
  if (!deviceToken) return null;
  for (const [familyId, family] of Object.entries(db.families)) {
    for (const [deviceId, device] of Object.entries(family.devices || {})) {
      if (device.deviceToken === deviceToken) {
        return { familyId, family, device: { ...device, deviceId }, deviceId };
      }
    }
  }
  return null;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`KidShield Sync Server running on http://0.0.0.0:${PORT}`);
  console.log('Use your PC LAN IP on phones (e.g. http://192.168.1.x:' + PORT + ')');
});
