const fs = require('fs');
const path = require('path');

const IS_VERCEL = Boolean(process.env.VERCEL);
const USE_BLOB = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const DATA_DIR = process.env.DATA_DIR || (
  IS_VERCEL ? '/tmp/kidshield-data' : path.join(__dirname, 'data')
);
const DB_FILE = process.env.DATABASE_PATH || path.join(DATA_DIR, 'kidshield-cloud.json');
const BLOB_PATH = 'kidshield-cloud.json';

if (!USE_BLOB) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.warn('[db] Could not create DATA_DIR:', err.message);
  }
}

function emptyDb() {
  return { families: {}, pairings: {}, events: {} };
}

let fileCache = null;

function readFileDb() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch { /* */ }
  return emptyDb();
}

function writeFileDb(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('[db] File write failed:', err.message);
    throw new Error(IS_VERCEL && !USE_BLOB
      ? 'Storage not configured — add Vercel Blob in dashboard (Storage → Blob)'
      : 'Database write failed');
  }
}

function loadBlobModule() {
  try {
    return require('@vercel/blob');
  } catch (err) {
    throw new Error('@vercel/blob not installed — run npm install in server/');
  }
}

async function readBlobDb() {
  try {
    const { head } = loadBlobModule();
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    let meta;
    try {
      meta = await head(BLOB_PATH, { token });
    } catch {
      return emptyDb();
    }
    if (!meta?.url) return emptyDb();
    const res = await fetch(meta.url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return emptyDb();
    return await res.json();
  } catch (err) {
    console.error('[db] Blob read failed:', err.message);
    return emptyDb();
  }
}

async function writeBlobDb(db) {
  const { put } = loadBlobModule();
  await put(BLOB_PATH, JSON.stringify(db), {
    access: 'private',
    addRandomSuffix: false,
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
}

async function readDb() {
  if (USE_BLOB) return readBlobDb();
  if (!fileCache) fileCache = readFileDb();
  return fileCache;
}

async function writeDb(db) {
  if (USE_BLOB) {
    await writeBlobDb(db);
    return;
  }
  fileCache = db;
  writeFileDb(db);
}

const Db = {
  async getFamily(id) {
    const db = await readDb();
    return db.families[id] || null;
  },

  async getFamilyByToken(token) {
    const db = await readDb();
    return Object.values(db.families).find(f => f.parentToken === token) || null;
  },

  async createFamily({ id, parentToken, parentName }) {
    const db = await readDb();
    db.families[id] = {
      id,
      parentToken,
      parentName,
      createdAt: Date.now(),
      children: {},
      devices: {},
    };
    await writeDb(db);
    return db.families[id];
  },

  async upsertChild(familyId, childId, snapshot) {
    const db = await readDb();
    const fam = db.families[familyId];
    if (!fam) return;
    fam.children[childId] = { snapshot, liveState: null, updatedAt: Date.now() };
    await writeDb(db);
  },

  async upsertChildren(familyId, children) {
    const db = await readDb();
    const fam = db.families[familyId];
    if (!fam) return;
    children.forEach(c => {
      if (c?.id) {
        fam.children[c.id] = { snapshot: c, liveState: null, updatedAt: Date.now() };
      }
    });
    await writeDb(db);
  },

  async setLiveState(familyId, childId, state) {
    const db = await readDb();
    const c = db.families[familyId]?.children?.[childId];
    if (c) {
      c.liveState = state;
      c.updatedAt = Date.now();
      await writeDb(db);
    }
  },

  async addPairing(code, familyId, childId, expiresAt) {
    const db = await readDb();
    db.pairings[code] = { familyId, childId, expiresAt };
    await writeDb(db);
  },

  async deletePairing(code) {
    const db = await readDb();
    delete db.pairings[code];
    await writeDb(db);
  },

  async cleanPairings() {
    const db = await readDb();
    const now = Date.now();
    Object.keys(db.pairings).forEach(code => {
      if (db.pairings[code].expiresAt < now) delete db.pairings[code];
    });
    await writeDb(db);
  },

  async hasPairing(code) {
    const db = await readDb();
    return Boolean(db.pairings[code]);
  },

  async getPairing(code) {
    const db = await readDb();
    return db.pairings[String(code)] || null;
  },

  async addDevice(familyId, device) {
    const db = await readDb();
    const fam = db.families[familyId];
    if (!fam) return;
    fam.devices[device.id] = device;
    await writeDb(db);
  },

  async getDeviceByToken(token) {
    const db = await readDb();
    for (const fam of Object.values(db.families)) {
      for (const d of Object.values(fam.devices || {})) {
        if (d.deviceToken === token) return { family: fam, device: d };
      }
    }
    return null;
  },

  async updateDeviceSeen(familyId, deviceId) {
    const db = await readDb();
    const d = db.families[familyId]?.devices?.[deviceId];
    if (d) {
      d.lastSeen = Date.now();
      await writeDb(db);
    }
  },

  async addEvent(familyId, event) {
    const db = await readDb();
    if (!db.events[familyId]) db.events[familyId] = [];
    db.events[familyId].unshift(event);
    db.events[familyId] = db.events[familyId].slice(0, 300);
    await writeDb(db);
  },

  async getEventsSince(familyId, since) {
    const db = await readDb();
    return (db.events[familyId] || []).filter(e => e.time > since);
  },
};

module.exports = Db;
