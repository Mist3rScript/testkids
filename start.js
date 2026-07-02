/**
 * Local dev bootstrap — installs deps to .deps/ if node_modules is missing/broken.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const depsDir = path.join(__dirname, '.deps', 'node_modules');
const hasExpress = fs.existsSync(path.join(depsDir, 'express'));

if (!fs.existsSync(path.join(__dirname, 'node_modules', 'express')) && !hasExpress) {
  console.log('Installing server dependencies to .deps/ …');
  const r = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', 'express', 'cors', 'dotenv', 'uuid', '--prefix', '.deps'],
    { cwd: __dirname, stdio: 'inherit' }
  );
  if (r.status !== 0) process.exit(r.status || 1);
}

if (fs.existsSync(depsDir)) {
  process.env.NODE_PATH = [depsDir, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
}

const app = require('./app');
const PORT = process.env.PORT || 3847;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`KidShield Cloud Server → http://0.0.0.0:${PORT}`);
});
