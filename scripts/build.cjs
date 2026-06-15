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

// 0. Self-heal the electron-builder node_modules collector.
//    Some build machines block script (.bat/.cmd) execution from user-writable
//    dirs (SRP/AppLocker). electron-builder 26's npm collector writes a temp .bat
//    and runs it via cmd.exe → `spawn EPERM`, killing the whole build. Patch it to
//    run `node npm-cli.js` directly instead (node.exe is allowed; .js is read as
//    data, not executed as a script). Harmless on machines without the policy, and
//    idempotent. npm install reinstalls the original, so we reapply on every build.
function ensureBuilderPatch() {
  console.log('\n=== Patching electron-builder collector (spawn EPERM workaround) ===');
  const f = path.join(root, 'node_modules/app-builder-lib/out/node-module-collector/nodeModulesCollector.js');
  if (!fs.existsSync(f)) { console.warn('  collector not found — skip'); return; }
  let s = fs.readFileSync(f, 'utf8');
  if (s.includes('LOCAL WORKAROUND (freewill-seedance)')) { console.log('  already patched'); return; }
  const findA =
    '        const execName = path.basename(command, path.extname(command));\n' +
    '        const isWindowsScriptFile = process.platform === "win32" && path.extname(command).toLowerCase() === ".cmd";\n' +
    '        if (isWindowsScriptFile) {';
  if (!s.includes(findA)) { console.warn('  anchor not found (electron-builder changed?) — skip, build may fail'); return; }
  const replA =
    '        const execName = path.basename(command, path.extname(command));\n' +
    '        let useShell = true;\n' +
    '        // LOCAL WORKAROUND (freewill-seedance): machine blocks script execution from\n' +
    '        // user-writable dirs (SRP/AppLocker) → temp .bat trick fails with EPERM. For\n' +
    '        // npm, run node + npm-cli.js directly. Reapplied by scripts/build.cjs.\n' +
    '        const npmCliJs = process.platform === "win32" && execName === "npm"\n' +
    '            ? path.join(path.dirname(command), "node_modules", "npm", "bin", "npm-cli.js")\n' +
    '            : null;\n' +
    '        const isWindowsScriptFile = process.platform === "win32" && path.extname(command).toLowerCase() === ".cmd";\n' +
    '        if (npmCliJs && require("fs").existsSync(npmCliJs)) {\n' +
    '            command = process.execPath;\n' +
    '            args = [npmCliJs, ...args];\n' +
    '            useShell = false;\n' +
    '        }\n' +
    '        else if (isWindowsScriptFile) {';
  s = s.replace(findA, replA).replace('shell: true,', 'shell: useShell,');
  fs.writeFileSync(f, s);
  console.log('  patched → node + npm-cli.js (no temp script)');
}
ensureBuilderPatch();

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
