/**
 * Build script for production:
 * 1. Vite build (frontend → dist/)
 * 2. Bundle server.ts → dist-server/server.cjs (with esbuild)
 * 3. Electron Builder packages everything into EXE
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');

function run(cmd, label) {
  console.log(`\n=== ${label} ===`);
  execSync(cmd, { cwd: root, stdio: 'inherit', shell: true });
}

// 1. Build frontend
run('npx vite build', 'Building frontend (Vite)');

// 2. Bundle server with esbuild (tree-shakes, bundles dependencies, single CJS file)
const distServer = path.join(root, 'dist-server');
if (!fs.existsSync(distServer)) fs.mkdirSync(distServer);

run(
  'npx esbuild server.ts --bundle --platform=node --target=node18 --format=cjs --outfile=dist-server/server.cjs --external:vite',
  'Bundling server (esbuild)'
);

// 3. Patch the bundled server to use production mode
const serverFile = path.join(distServer, 'server.cjs');
let serverCode = fs.readFileSync(serverFile, 'utf8');
// Force production mode in the bundle
serverCode = serverCode.replace(
  "process.env.NODE_ENV !== 'production'",
  "false /* production build */"
);
fs.writeFileSync(serverFile, serverCode);

console.log('\n=== Build complete ===');
console.log('Frontend: dist/');
console.log('Server: dist-server/server.cjs');
console.log('\nRun "npx electron-builder" to package the EXE.');
