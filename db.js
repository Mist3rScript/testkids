const fs = require('fs');
const path = require('path');

const IS_VERCEL = Boolean(process.env.VERCEL);
const HAS_BLOB = Boolean(
  process.env.BLOB_READ_WRITE_TOKEN ||
  process.env.BLOB_STORE_ID
);
const DATA_DIR = process.env.DATA_DIR || (
  IS_VERCEL ? '/tmp/kidshield-data' : path.join(__dirname, 'data')
);
const DB_FILE = process.env.DATABASE_PATH || path.join(DATA_DIR, 'kidshield-cloud.json');
const BLOB_PATH = 'kidshield-cloud.json';

function blobSetupError() {
  return [
    'Vercel Blob غير مربوط بالمشروع.',
    '1) Vercel Dashboard → مشروع testkids → Storage → Create → Blob',
    '2) Connect to Project → اختر testkids',
    '3) Deployments → Redeploy',
    '4) تحقق: /api/health يجب blobConfigured=true',
  ].join(' ');
}

function ensureDataDir() {
  if (HAS_BLOB) return;
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.warn('[db] Could not create DATA_DIR:', err.message);
  }
}

ensureDataDir();

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
  if (IS_VERCEL && !HAS_BLOB) {
    throw new Error(blobSetupError());
  }
  ensureDataDir();
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (err) {
    console.error('[db] File write failed:', err.message);
    throw new Error(IS_VERCEL ? blobSetupError() : 'Database write failed');
  }
}

function loadBlobModule() {
  try {
    return require('@vercel/blob');
  } catch {
    throw new Error('@vercel/blob missing — run npm install in server/');
  }
}

async function streamToText(stream) {
  if (!stream) return '';
  if (typeof stream === 'string') return stream;
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readBlobDb() {
  try {
    const { get } = loadBlobModule();
    const result = await get(BLOB_PATH, { access: 'private' });
    if (!result || result.statusCode === 404) return emptyDb();
    if (result.statusCode !== 200) return emptyDb();
    const text = await streamToText(result.stream);
    if (!text) return emptyDb();
    return JSON.parse(text);
  } catch (err) {
    if (err?.message?.includes('does not exist') || err?.name === 'BlobNotFoundError') {
      return emptyDb();
    }
    console.error('[db] Blob read failed:', err.message);
    throw new Error(`Blob read failed: ${err.message}`);
  }
}

async function writeBlobDb(db) {
  try {
    const { put } = loadBlobModule();
    await put(BLOB_PATH, JSON.stringify(db), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
  } catch (err) {
    console.error('[db] Blob write failed:', err.message);
    throw new Error(`Blob write failed: ${err.message}. ${blobSetupError()}`);
  }
}

async function readDb() {
  if (HAS_BLOB) return readBlobDb();
  if (!fileCache) fileCache = readFileDb();
  return fileCache;
}

async function writeDb(db) {
  if (HAS_BLOB) {
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
module.exports.hasBlobStorage = () => HAS_BLOB;
