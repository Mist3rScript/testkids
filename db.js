const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = process.env.DATABASE_PATH || path.join(DATA_DIR, 'kidshield-cloud.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function emptyDb() {
  return { families: {}, pairings: {}, events: {} };
}

function load() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch { /* */ }
  return emptyDb();
}

function save(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let cache = load();

const Db = {
  getFamilies() { return cache.families; },
  getPairings() { return cache.pairings; },
  getEvents() { return cache.events; },

  getFamily(id) {
    return cache.families[id] || null;
  },

  getFamilyByToken(token) {
    return Object.values(cache.families).find(f => f.parentToken === token) || null;
  },

  createFamily({ id, parentToken, parentName }) {
    cache.families[id] = {
      id,
      parentToken,
      parentName,
      createdAt: Date.now(),
      children: {},
      devices: {},
    };
    save(cache);
    return cache.families[id];
  },

  upsertChild(familyId, childId, snapshot) {
    const fam = cache.families[familyId];
    if (!fam) return;
    fam.children[childId] = { snapshot, liveState: null, updatedAt: Date.now() };
    save(cache);
  },

  upsertChildren(familyId, children) {
    children.forEach(c => {
      if (c?.id) this.upsertChild(familyId, c.id, c);
    });
  },

  setLiveState(familyId, childId, state) {
    const c = cache.families[familyId]?.children?.[childId];
    if (c) {
      c.liveState = state;
      c.updatedAt = Date.now();
      save(cache);
    }
  },

  addPairing(code, familyId, childId, expiresAt) {
    cache.pairings[code] = { familyId, childId, expiresAt };
    save(cache);
  },

  deletePairing(code) {
    delete cache.pairings[code];
    save(cache);
  },

  cleanPairings() {
    const now = Date.now();
    Object.keys(cache.pairings).forEach(code => {
      if (cache.pairings[code].expiresAt < now) delete cache.pairings[code];
    });
    save(cache);
  },

  addDevice(familyId, device) {
    const fam = cache.families[familyId];
    if (!fam) return;
    fam.devices[device.id] = device;
    save(cache);
  },

  getDeviceByToken(token) {
    for (const fam of Object.values(cache.families)) {
      for (const d of Object.values(fam.devices || {})) {
        if (d.deviceToken === token) return { family: fam, device: d };
      }
    }
    return null;
  },

  updateDeviceSeen(familyId, deviceId) {
    const d = cache.families[familyId]?.devices?.[deviceId];
    if (d) {
      d.lastSeen = Date.now();
      save(cache);
    }
  },

  addEvent(familyId, event) {
    if (!cache.events[familyId]) cache.events[familyId] = [];
    cache.events[familyId].unshift(event);
    cache.events[familyId] = cache.events[familyId].slice(0, 300);
    save(cache);
  },

  getEventsSince(familyId, since) {
    return (cache.events[familyId] || []).filter(e => e.time > since);
  },
};

module.exports = Db;
