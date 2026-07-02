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

function normalizePairCode(code) {
  return String(code || '').replace(/\D/g, '').slice(0, 6);
}

function cleanExpiredPairings(db) {
  const now = Date.now();
  Object.keys(db.pairings || {}).forEach(code => {
    if (db.pairings[code].expiresAt < now) delete db.pairings[code];
  });
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

async function readBlobDbLegacy(blob) {
  const opts = { ...blobTokenOpts(), prefix: BLOB_PATH, limit: 1 };

  if (typeof blob.list === 'function') {
    const listed = await blob.list(opts);
    const item = listed?.blobs?.[0];
    if (item?.url || item?.downloadUrl) {
      const data = await fetchBlobUrl(item.downloadUrl || item.url);
      if (data) return { db: data, etag: null };
    }
  }

  if (typeof blob.head === 'function') {
    try {
      const meta = await blob.head(BLOB_PATH, blobTokenOpts());
      if (meta?.downloadUrl || meta?.url) {
        const data = await fetchBlobUrl(meta.downloadUrl || meta.url);
        if (data) return { db: data, etag: meta.etag || null };
      }
    } catch {
      /* not found */
    }
  }

  return { db: emptyDb(), etag: null };
}

async function readDbWithMeta() {
  if (!HAS_BLOB) {
    if (!fileCache) fileCache = readFileDb();
    return { db: structuredClone(fileCache), etag: null };
  }

  try {
    const blob = loadBlobModule();
    if (typeof blob.get === 'function') {
      const result = await blob.get(BLOB_PATH, { access: 'private' });
      if (!result || result.statusCode !== 200 || !result.stream) {
        return { db: emptyDb(), etag: null };
      }
      const text = await streamToText(result.stream);
      return {
        db: text ? JSON.parse(text) : emptyDb(),
        etag: result.blob?.etag || null,
      };
    }
    return await readBlobDbLegacy(blob);
  } catch (err) {
    if (err?.name === 'BlobNotFoundError') return { db: emptyDb(), etag: null };
    console.error('[db] Blob read failed:', err.message);
    throw new Error(`Blob read failed: ${err.message}`);
  }
}

async function writeDbWithMeta(db, etag) {
  if (HAS_BLOB) {
    const blob = loadBlobModule();
    const body = JSON.stringify(db);
    const putOpts = {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    };

    if (typeof blob.get === 'function') {
      if (etag) putOpts.ifMatch = etag;
      await blob.put(BLOB_PATH, body, putOpts);
      return;
    }

    await blob.put(BLOB_PATH, body, {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      ...blobTokenOpts(),
    });
    return;
  }

  fileCache = db;
  writeFileDb(db);
}

function isPreconditionError(err) {
  return err?.name === 'BlobPreconditionFailedError' ||
    String(err?.message || '').includes('Precondition');
}

async function mutate(fn, maxRetries = 8) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { db, etag } = await readDbWithMeta();
    cleanExpiredPairings(db);
    const result = await fn(db);
    try {
      await writeDbWithMeta(db, etag);
      return result;
    } catch (err) {
      if (isPreconditionError(err) && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 40 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Database busy — retry');
}

async function readDb() {
  const { db } = await readDbWithMeta();
  return db;
}

async function writeDb(db) {
  await writeDbWithMeta(db, null);
}

const Db = {
  normalizePairCode,

  mutate,

  async getFamily(id) {
    const db = await readDb();
    return db.families[id] || null;
  },

  async getFamilyByToken(token) {
    const db = await readDb();
    return Object.values(db.families).find(f => f.parentToken === token) || null;
  },

  async createFamily({ id, parentToken, parentName }) {
    return mutate(db => {
      db.families[id] = {
        id,
        parentToken,
        parentName,
        createdAt: Date.now(),
        children: {},
        devices: {},
      };
      return db.families[id];
    });
  },

  async createPairingCode(familyId, childId, snapshot, ttlMs, genCodeFn) {
    return mutate(db => {
      const fam = db.families[familyId];
      if (!fam) throw new Error('Family not found');
      const now = Date.now();
      fam.children[childId] = { snapshot, liveState: null, updatedAt: now };
      let code;
      let tries = 0;
      do {
        code = genCodeFn();
        tries += 1;
      } while (db.pairings[code] && tries < 30);
      db.pairings[code] = { familyId, childId, expiresAt: now + ttlMs };
      return code;
    });
  },

  async joinWithPairingCode(code, deviceName, genIds) {
    const normalized = normalizePairCode(code);
    if (normalized.length !== 6) {
      return { ok: false, reason: 'invalid_format' };
    }

    return mutate(db => {
      const pairing = db.pairings[normalized];
      const now = Date.now();
      if (!pairing || pairing.expiresAt < now) {
        return { ok: false, reason: 'invalid_or_expired' };
      }
      const fam = db.families[pairing.familyId];
      const child = fam?.children?.[pairing.childId];
      if (!child) return { ok: false, reason: 'no_child' };

      const { deviceId, deviceToken } = genIds();
      fam.devices[deviceId] = {
        id: deviceId,
        deviceToken,
        childId: pairing.childId,
        deviceName: deviceName || 'Kid Device',
        pairedAt: now,
        lastSeen: now,
        online: true,
      };
      delete db.pairings[normalized];

      return {
        ok: true,
        deviceId,
        deviceToken,
        familyId: pairing.familyId,
        childId: pairing.childId,
        snapshot: child.snapshot,
      };
    });
  },

  async upsertChild(familyId, childId, snapshot) {
    return mutate(db => {
      const fam = db.families[familyId];
      if (!fam) return;
      fam.children[childId] = { snapshot, liveState: null, updatedAt: Date.now() };
    });
  },

  async upsertChildren(familyId, children) {
    return mutate(db => {
      const fam = db.families[familyId];
      if (!fam) return;
      children.forEach(c => {
        if (c?.id) {
          fam.children[c.id] = { snapshot: c, liveState: null, updatedAt: Date.now() };
        }
      });
    });
  },

  async setLiveState(familyId, childId, state) {
    return mutate(db => {
      const c = db.families[familyId]?.children?.[childId];
      if (c) {
        c.liveState = state;
        c.updatedAt = Date.now();
      }
    });
  },

  async addDevice(familyId, device) {
    return mutate(db => {
      const fam = db.families[familyId];
      if (!fam) return;
      fam.devices[device.id] = device;
    });
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
    return mutate(db => {
      const d = db.families[familyId]?.devices?.[deviceId];
      if (d) d.lastSeen = Date.now();
    });
  },

  async addEvent(familyId, event) {
    return mutate(db => {
      if (!db.events[familyId]) db.events[familyId] = [];
      db.events[familyId].unshift(event);
      db.events[familyId] = db.events[familyId].slice(0, 300);
    });
  },

  async getEventsSince(familyId, since) {
    const db = await readDb();
    return (db.events[familyId] || []).filter(e => e.time > since);
  },

  /** @deprecated — use mutate / createPairingCode; kept for older deploys */
  async cleanPairings() {
    return mutate(db => { cleanExpiredPairings(db); });
  },

  async addPairing(code, familyId, childId, expiresAt) {
    return mutate(db => {
      db.pairings[String(code)] = { familyId, childId, expiresAt };
    });
  },

  async deletePairing(code) {
    return mutate(db => {
      delete db.pairings[String(code)];
    });
  },

  async hasPairing(code) {
    const db = await readDb();
    cleanExpiredPairings(db);
    return Boolean(db.pairings[String(code)]);
  },

  async getPairing(code) {
    const db = await readDb();
    cleanExpiredPairings(db);
    return db.pairings[normalizePairCode(code)] || db.pairings[String(code)] || null;
  },
};

module.exports = Db;
module.exports.hasBlobStorage = () => HAS_BLOB;
module.exports.getBlobSdkVersion = getBlobSdkVersion;
