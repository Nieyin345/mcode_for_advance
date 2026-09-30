/** Electron 44 downloads on demand. Forward the repository's existing mirror
 * explicitly: direct require('electron') / the new installer no longer reliably
 * inherits arbitrary .npmrc keys. Use the upstream installer and checksum checks;
 * do not implement a second downloader or change TLS settings. */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');

function ensureElectron() {
  if (process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) return 0;
  const appDir = path.resolve(__dirname, '..');
  const req = createRequire(path.join(appDir, 'package.json'));
  const manifest = req.resolve('electron/package.json');
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  const installer = typeof pkg.bin === 'object' ? pkg.bin['install-electron'] : undefined;
  if (!installer) throw new Error('Installed Electron has no install-electron entry');
  const env = { ...process.env };
  if (!env.ELECTRON_MIRROR) {
    const npmrc = path.resolve(appDir, '../../.npmrc');
    if (fs.existsSync(npmrc)) {
      const configured = fs.readFileSync(npmrc, 'utf8').match(/^\s*electron_mirror\s*=\s*(.+?)\s*$/mi)?.[1];
      if (configured) {
        const mirror = configured.replace(/^['"]|['"]$/g, '').replace(/\$\{([^}]+)\}/g, (_, key) => env[key] || '');
        if (new URL(mirror).protocol !== 'https:') throw new Error('Project Electron mirror must use HTTPS');
        env.ELECTRON_MIRROR = mirror;
      }
    }
  }
  // Use the verified upstream installer invocation without changing integrity/TLS options.
  const result = spawnSync(process.execPath, [path.resolve(path.dirname(manifest), installer), '--no'], { cwd: appDir, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
try { process.exitCode = ensureElectron(); }
catch (error) { console.error('Electron runtime setup failed: ' + error.message); process.exitCode = 1; }
