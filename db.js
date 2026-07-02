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
const PAIRINGS_BLOB_PATH = 'kidshield-pairings.json';
const AUTH_BLOB_PATH = 'kidshield-auth.json';
const DEVICES_BLOB_PATH = 'kidshield-devices.json';
const PAIRINGS_FILE = path.join(DATA_DIR, 'kidshield-pairings.json');
const AUTH_FILE = path.join(DATA_DIR, 'kidshield-auth.json');
const DEVICES_FILE = path.join(DATA_DIR, 'kidshield-devices.json');

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
let pairingsFileCache = null;
let authFileCache = null;
let devicesFileCache = null;
/** Warm cache — same Vercel lambda instance can read what it just wrote */
let warmDb = null;
let warmPairings = null;
let warmAuth = null;
let warmDevices = null;

function emptyPairingsStore() {
  return { pairings: {}, _version: 0 };
}

function emptyAuthStore() {
  return { tokens: {}, _version: 0 };
}

function emptyDevicesStore() {
  return { tokens: {}, _version: 0 };
}

function blobPutOpts() {
  return {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    ...blobTokenOpts(),
  };
}

async function readBlobJson(pathname, emptyFn) {
  if (!HAS_BLOB) return emptyFn();

  const blob = loadBlobModule();
  const getOpts = { access: 'private', ...blobTokenOpts() };

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      if (typeof blob.get === 'function') {
        let result;
        try {
          result = await blob.get(pathname, getOpts);
        } catch (err) {
          if (err?.name === 'BlobNotFoundError') return emptyFn();
          throw err;
        }
        if (!result || result.statusCode === 404) {
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 80 * (attempt + 1)));
            continue;
          }
          return emptyFn();
        }
        if (result.statusCode !== 200 || !result.stream) return emptyFn();
        const text = await streamToText(result.stream);
        try {
          return text ? JSON.parse(text) : emptyFn();
        } catch {
          console.warn('[db] Corrupt blob JSON at', pathname);
          return emptyFn();
        }
      }

      if (typeof blob.head === 'function') {
        try {
          const meta = await blob.head(pathname, blobTokenOpts());
          if (meta?.downloadUrl || meta?.url) {
            const data = await fetchBlobUrl(meta.downloadUrl || meta.url);
            if (data) return data;
          }
        } catch (err) {
          if (err?.name !== 'BlobNotFoundError' && attempt === 3) throw err;
        }
      }
    } catch (err) {
      if (err?.name === 'BlobNotFoundError') return emptyFn();
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 80 * (attempt + 1)));
    }
  }
  return emptyFn();
}

async function writeBlobJson(pathname, data) {
  if (!HAS_BLOB) return;
  const blob = loadBlobModule();
  await blob.put(pathname, JSON.stringify(data), blobPutOpts());
}

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
    const db = JSON.parse(JSON.stringify(fileCache));
    warmDb = db;
    return { db, etag: null };
  }

  try {
    const data = await readBlobJson(BLOB_PATH, emptyDb);
    warmDb = data;
    return { db: JSON.parse(JSON.stringify(data)), etag: null };
  } catch (err) {
    if (warmDb) return { db: JSON.parse(JSON.stringify(warmDb)), etag: null };
    if (err?.name === 'BlobNotFoundError') return { db: emptyDb(), etag: null };
    console.error('[db] Blob read failed:', err.message);
    throw new Error(`Blob read failed: ${err.message}`);
  }
}

async function writeDbWithMeta(db) {
  warmDb = db;
  if (HAS_BLOB) {
    await writeBlobJson(BLOB_PATH, db);
    return;
  }
  fileCache = db;
  writeFileDb(db);
}

function isRetryableWriteError(err) {
  const msg = String(err?.message || '');
  return err?.name === 'BlobPreconditionFailedError' ||
    msg.includes('Precondition') ||
    msg.includes('ETag mismatch') ||
    msg.includes('conflict');
}

/** Merge pairings/devices from fresher blob so concurrent writes don't drop codes */
function mergeConcurrentState(target, fresh) {
  if (!fresh) return;
  const now = Date.now();
  Object.entries(fresh.pairings || {}).forEach(([code, p]) => {
    if (p.expiresAt > now && !target.pairings[code]) {
      target.pairings[code] = p;
    }
  });
  Object.entries(fresh.families || {}).forEach(([famId, fam]) => {
    if (!target.families[famId]) {
      target.families[famId] = fam;
      return;
    }
    const tFam = target.families[famId];
    Object.entries(fam.devices || {}).forEach(([devId, dev]) => {
      if (!tFam.devices[devId]) tFam.devices[devId] = dev;
    });
    Object.entries(fam.children || {}).forEach(([childId, child]) => {
      if (!tFam.children[childId]) tFam.children[childId] = child;
    });
  });
}

async function mutate(fn, maxRetries = 10) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { db } = await readDbWithMeta();
    cleanExpiredPairings(db);
    const result = await fn(db);
    try {
      const { db: fresh } = await readDbWithMeta();
      mergeConcurrentState(db, fresh);
      db._version = Math.max(db._version || 0, fresh._version || 0) + 1;
      await writeDbWithMeta(db);
      return result;
    } catch (err) {
      if (isRetryableWriteError(err) && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Database busy — retry');
}

function readPairingsFileLocal() {
  try {
    if (fs.existsSync(PAIRINGS_FILE)) return JSON.parse(fs.readFileSync(PAIRINGS_FILE, 'utf8'));
  } catch { /* */ }
  return emptyPairingsStore();
}

function writePairingsFileLocal(store) {
  ensureDataDir();
  fs.writeFileSync(PAIRINGS_FILE, JSON.stringify(store, null, 2));
}

function cleanExpiredInStore(store) {
  const now = Date.now();
  Object.keys(store.pairings || {}).forEach(code => {
    if (store.pairings[code].expiresAt < now) delete store.pairings[code];
  });
}

async function readPairingsStore() {
  if (!HAS_BLOB) {
    if (!pairingsFileCache) pairingsFileCache = readPairingsFileLocal();
    return JSON.parse(JSON.stringify(pairingsFileCache));
  }
  const store = await readBlobJson(PAIRINGS_BLOB_PATH, emptyPairingsStore);
  warmPairings = store;
  return JSON.parse(JSON.stringify(store));
}

async function writePairingsStore(store) {
  warmPairings = store;
  if (!HAS_BLOB) {
    pairingsFileCache = store;
    writePairingsFileLocal(store);
    return;
  }
  await writeBlobJson(PAIRINGS_BLOB_PATH, store);
}

function readAuthFileLocal() {
  try {
    if (fs.existsSync(AUTH_FILE)) return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch { /* */ }
  return emptyAuthStore();
}

function writeAuthFileLocal(store) {
  ensureDataDir();
  fs.writeFileSync(AUTH_FILE, JSON.stringify(store, null, 2));
}

async function readAuthStore() {
  if (!HAS_BLOB) {
    if (!authFileCache) authFileCache = readAuthFileLocal();
    return JSON.parse(JSON.stringify(authFileCache));
  }
  const store = await readBlobJson(AUTH_BLOB_PATH, emptyAuthStore);
  warmAuth = store;
  return JSON.parse(JSON.stringify(store));
}

async function writeAuthStore(store) {
  warmAuth = store;
  if (!HAS_BLOB) {
    authFileCache = store;
    writeAuthFileLocal(store);
    return;
  }
  await writeBlobJson(AUTH_BLOB_PATH, store);
}

function readDevicesFileLocal() {
  try {
    if (fs.existsSync(DEVICES_FILE)) return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
  } catch { /* */ }
  return emptyDevicesStore();
}

function writeDevicesFileLocal(store) {
  ensureDataDir();
  fs.writeFileSync(DEVICES_FILE, JSON.stringify(store, null, 2));
}

async function readDevicesStore() {
  if (!HAS_BLOB) {
    if (!devicesFileCache) devicesFileCache = readDevicesFileLocal();
    return JSON.parse(JSON.stringify(devicesFileCache));
  }
  const store = await readBlobJson(DEVICES_BLOB_PATH, emptyDevicesStore);
  warmDevices = store;
  return JSON.parse(JSON.stringify(store));
}

async function writeDevicesStore(store) {
  warmDevices = store;
  if (!HAS_BLOB) {
    devicesFileCache = store;
    writeDevicesFileLocal(store);
    return;
  }
  await writeBlobJson(DEVICES_BLOB_PATH, store);
}

async function mutateDevices(fn, maxRetries = 10) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const store = await readDevicesStore();
    const result = await fn(store);
    try {
      store._version = (store._version || 0) + 1;
      await writeDevicesStore(store);
      return result;
    } catch (err) {
      if (isRetryableWriteError(err) && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Devices store busy — retry');
}

function buildDeviceLookup(entry, token) {
  if (!entry) return null;
  const device = entry.device || {
    id: entry.deviceId,
    deviceToken: token,
    childId: entry.childId,
    deviceName: entry.deviceName || 'Kid Device',
    pairedAt: entry.pairedAt || Date.now(),
    lastSeen: entry.lastSeen || Date.now(),
    online: true,
  };
  const family = {
    id: entry.familyId,
    devices: { [entry.deviceId]: device },
    children: {
      [entry.childId]: {
        snapshot: entry.snapshot || null,
        liveState: null,
        updatedAt: Date.now(),
      },
    },
  };
  return { family, device };
}

async function lookupDeviceEntry(token) {
  if (!token) return null;
  if (warmDevices?.tokens?.[token]) return warmDevices.tokens[token];

  for (let attempt = 0; attempt < 4; attempt++) {
    const store = await readDevicesStore();
    if (store.tokens?.[token]) return store.tokens[token];
    if (attempt < 3) await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
  }
  return null;
}

async function mutateAuth(fn, maxRetries = 10) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const store = await readAuthStore();
    const result = await fn(store);
    try {
      store._version = (store._version || 0) + 1;
      await writeAuthStore(store);
      return result;
    } catch (err) {
      if (isRetryableWriteError(err) && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Auth store busy — retry');
}

async function mutatePairings(fn, maxRetries = 10) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const store = await readPairingsStore();
    cleanExpiredInStore(store);
    const result = await fn(store);
    try {
      store._version = (store._version || 0) + 1;
      await writePairingsStore(store);
      return result;
    } catch (err) {
      if (isRetryableWriteError(err) && attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Pairings store busy — retry');
}

async function lookupPairing(normalized) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (warmPairings?.pairings?.[normalized]) {
      const p = warmPairings.pairings[normalized];
      if (p.expiresAt > Date.now()) return p;
    }
    const store = await readPairingsStore();
    cleanExpiredInStore(store);
    if (store.pairings[normalized]) return store.pairings[normalized];
    const db = await readDb();
    cleanExpiredPairings(db);
    if (db.pairings[normalized]) return db.pairings[normalized];
    if (attempt < 3) await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
  }
  return null;
}

async function readDb() {
  const { db } = await readDbWithMeta();
  return db;
}

async function writeDb(db) {
  await writeDbWithMeta(db);
}

const Db = {
  normalizePairCode,

  mutate,

  async getFamily(id) {
    const db = await readDb();
    return db.families[id] || null;
  },

  /** Merge devices from main DB + devices index (reliable on Vercel Blob) */
  async getDevicesForFamily(familyId) {
    const db = await readDb();
    const merged = { ...(db.families[familyId]?.devices || {}) };
    const store = await readDevicesStore();
    const now = Date.now();
    for (const entry of Object.values(store.tokens || {})) {
      if (entry.familyId !== familyId || !entry.deviceId) continue;
      const device = entry.device || {
        id: entry.deviceId,
        deviceToken: entry.deviceToken,
        childId: entry.childId,
        deviceName: entry.deviceName || 'Kid Device',
        pairedAt: entry.pairedAt || now,
        lastSeen: entry.lastSeen || now,
        online: true,
      };
      merged[entry.deviceId] = device;
    }
    return merged;
  },

  async getDevicesForChild(familyId, childId) {
    const all = await this.getDevicesForFamily(familyId);
    return Object.values(all).filter(d => d.childId === childId);
  },

  async getFamilyByToken(token) {
    if (!token) return null;

    if (warmDb?.families) {
      const warmHit = Object.values(warmDb.families).find(f => f.parentToken === token);
      if (warmHit) return warmHit;
    }

    try {
      const auth = await readAuthStore();
      const familyId = auth.tokens?.[token];
      if (familyId) {
        const db = await readDb();
        if (db.families?.[familyId]) return db.families[familyId];
      }
    } catch { /* fallback below */ }

    const db = await readDb();
    return Object.values(db.families || {}).find(f => f.parentToken === token) || null;
  },

  async createFamily({ id, parentToken, parentName }) {
    const family = await mutate(db => {
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

    await mutateAuth(store => {
      store.tokens[parentToken] = id;
    });

    return family;
  },

  async createPairingCode(familyId, childId, snapshot, ttlMs, genCodeFn) {
    await mutate(db => {
      const fam = db.families[familyId];
      if (!fam) throw new Error('Family not found');
      fam.children[childId] = { snapshot, liveState: null, updatedAt: Date.now() };
    });

    return mutatePairings(store => {
      const now = Date.now();
      let code;
      let tries = 0;
      do {
        code = genCodeFn();
        tries += 1;
      } while (store.pairings[code] && tries < 30);
      store.pairings[code] = { familyId, childId, expiresAt: now + ttlMs };
      return code;
    });
  },

  async joinWithPairingCode(code, deviceName, genIds) {
    const normalized = normalizePairCode(code);
    if (normalized.length !== 6) {
      return { ok: false, reason: 'invalid_format' };
    }

    const pairing = await lookupPairing(normalized);
    const now = Date.now();
    if (!pairing || pairing.expiresAt < now) {
      return { ok: false, reason: 'invalid_or_expired' };
    }

    const result = await mutate(db => {
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

      return {
        ok: true,
        deviceId,
        deviceToken,
        familyId: pairing.familyId,
        childId: pairing.childId,
        snapshot: child.snapshot,
      };
    });

    if (result.ok) {
      await mutatePairings(store => {
        delete store.pairings[normalized];
      });
      await mutateDevices(store => {
        store.tokens[result.deviceToken] = {
          familyId: result.familyId,
          deviceId: result.deviceId,
          childId: result.childId,
          deviceName: deviceName || 'Kid Device',
          pairedAt: now,
          lastSeen: now,
          snapshot: result.snapshot,
          device: {
            id: result.deviceId,
            deviceToken: result.deviceToken,
            childId: result.childId,
            deviceName: deviceName || 'Kid Device',
            pairedAt: now,
            lastSeen: now,
            online: true,
          },
        };
      });
    }

    return result;
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

  async removeDevice(familyId, deviceId, deviceToken) {
    await mutate(db => {
      const fam = db.families[familyId];
      if (fam?.devices) delete fam.devices[deviceId];
    });
    if (deviceToken) {
      await mutateDevices(store => {
        delete store.tokens[deviceToken];
        for (const [tok, entry] of Object.entries(store.tokens || {})) {
          if (entry.familyId === familyId && entry.deviceId === deviceId) {
            delete store.tokens[tok];
          }
        }
      });
    }
  },

  async getDeviceByToken(token) {
    const entry = await lookupDeviceEntry(token);
    if (entry) {
      const fromIndex = buildDeviceLookup(entry, token);
      if (fromIndex) return fromIndex;
    }

    const db = await readDb();
    for (const fam of Object.values(db.families || {})) {
      for (const d of Object.values(fam.devices || {})) {
        if (d.deviceToken === token) return { family: fam, device: d };
      }
    }
    return null;
  },

  async updateDeviceSeen(familyId, deviceId) {
    await mutate(db => {
      const d = db.families[familyId]?.devices?.[deviceId];
      if (d) d.lastSeen = Date.now();
    });
    await mutateDevices(store => {
      for (const entry of Object.values(store.tokens || {})) {
        if (entry.familyId === familyId && entry.deviceId === deviceId) {
          entry.lastSeen = Date.now();
          if (entry.device) entry.device.lastSeen = Date.now();
        }
      }
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
    return lookupPairing(normalizePairCode(code));
  },

  async getStats() {
    const db = await readDb();
    const pairings = await readPairingsStore();
    const auth = await readAuthStore();
    cleanExpiredPairings(db);
    cleanExpiredInStore(pairings);
    return {
      familyCount: Object.keys(db.families || {}).length,
      pairingCount: Object.keys(pairings.pairings || {}).length,
      tokenCount: Object.keys(auth.tokens || {}).length,
    };
  },
};

module.exports = Db;
module.exports.hasBlobStorage = () => HAS_BLOB;
module.exports.getBlobSdkVersion = getBlobSdkVersion;
