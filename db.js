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
    '1) Vercel Dashboard → Storage → Blob → Connect to Project',
    '2) Deployments → Redeploy',
    '3) /api/health → blobConfigured=true, blobSdkVersion=2.x',
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

function getBlobSdkVersion() {
  try {
    const pkgPath = path.join(__dirname, 'node_modules', '@vercel/blob', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  } catch {
    return null;
  }
}

function blobTokenOpts() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return token ? { token } : {};
}

async function streamToText(stream) {
  if (!stream) return '';
  if (typeof stream === 'string') return stream;
  return new Response(stream).text();
}

async function fetchBlobUrl(url) {
  const headers = {};
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    headers.Authorization = `Bearer ${process.env.BLOB_READ_WRITE_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  return res.json();
}

async function readBlobDbV2(blob) {
  const result = await blob.get(BLOB_PATH, { access: 'private' });
  if (!result || result.statusCode !== 200 || !result.stream) return emptyDb();
  const text = await streamToText(result.stream);
  if (!text) return emptyDb();
  return JSON.parse(text);
}

async function readBlobDbLegacy(blob) {
  const opts = { ...blobTokenOpts(), prefix: BLOB_PATH, limit: 1 };

  if (typeof blob.list === 'function') {
    const listed = await blob.list(opts);
    const item = listed?.blobs?.[0];
    if (item?.url || item?.downloadUrl) {
      const data = await fetchBlobUrl(item.downloadUrl || item.url);
      if (data) return data;
    }
  }

  if (typeof blob.head === 'function') {
    try {
      const meta = await blob.head(BLOB_PATH, blobTokenOpts());
      if (meta?.downloadUrl || meta?.url) {
        const data = await fetchBlobUrl(meta.downloadUrl || meta.url);
        if (data) return data;
      }
    } catch {
      /* not found */
    }
  }

  return emptyDb();
}

async function readBlobDb() {
  try {
    const blob = loadBlobModule();
    if (typeof blob.get === 'function') {
      return await readBlobDbV2(blob);
    }
    console.warn('[db] @vercel/blob v1 — using list/head fallback. Upgrade to 2.5.0 on deploy.');
    return await readBlobDbLegacy(blob);
  } catch (err) {
    if (err?.name === 'BlobNotFoundError') return emptyDb();
    console.error('[db] Blob read failed:', err.message);
    throw new Error(`Blob read failed: ${err.message}`);
  }
}

async function writeBlobDb(db) {
  try {
    const blob = loadBlobModule();
    const body = JSON.stringify(db);

    if (typeof blob.get === 'function') {
      await blob.put(BLOB_PATH, body, {
        access: 'private',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
      });
      return;
    }

    await blob.put(BLOB_PATH, body, {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      ...blobTokenOpts(),
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
module.exports.getBlobSdkVersion = getBlobSdkVersion;
