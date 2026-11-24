// 진짜 electron/main.cjs + preload + server.ts 를 격리로 띄운다. BytePlus · 시트 · NCP · R2 는 모두 가짜(fake.mjs, 127.0.0.1:3946).
// Gemini 는 서버에 주소가 박혀 있어 키를 일부러 틀린 값으로 둔다 — 시험은 화면의 fetch 를 가로채므로 서버까지 가지 않는다.
const path = require('path');
const fs = require('fs');
const { app, shell } = require('electron');

const ROOT = process.env.HARNESS_ROOT;
const REPO = process.env.REPO;
for (const d of ['user', 'docs', 'cache', 'lib']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });

const FAKE = process.env.HARNESS_FAKE || 'http://127.0.0.1:3946';   // 슬롯(병렬 시험, 11/24) — run-harness-assets.ps1 -Slot
Object.assign(process.env, {
  SEEDANCE_PORT: process.env.HARNESS_APP_PORT || '3958',
  MEDIA_CACHE_DIR: path.join(ROOT, 'cache'),
  ELEMENT_LIBRARY_DIR: path.join(ROOT, 'lib'),
  SEEDANCE_GATEWAY: 'off',
  SEEDANCE_API_KEY: 'test',
  SEEDANCE_GEMINI_KEY: 'invalid-test-key',
  NANOBANANA_STUDIO_KEY: 'invalid-test-key',
  SEEDANCE_BP_BASE: FAKE,
  SEEDANCE_TRACKER_URL: FAKE,
  SEEDANCE_GATEWAY_URL: FAKE,
  SEEDANCE_NCP_ENDPOINT: FAKE,
  SEEDANCE_NCP_BUCKET: 'fake',
  SEEDANCE_NCP_ACCESS_KEY_ID: 'fake',
  SEEDANCE_NCP_SECRET_ACCESS_KEY: 'fake',
  R2_ENDPOINT: FAKE,
  R2_BUCKET: 'fake',
  R2_ACCESS_KEY_ID: 'fake',
  R2_SECRET_ACCESS_KEY: 'fake',
});

app.setPath('userData', path.join(ROOT, 'user'));
app.setPath('documents', path.join(ROOT, 'docs'));
app.setPath('appData', path.join(ROOT, 'appdata'));
app.commandLine.appendSwitch('remote-debugging-port', process.env.HARNESS_CDP_PORT || '9612');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

shell.showItemInFolder = () => {};
shell.openPath = async () => '';

// 트레이 메뉴를 붙잡아 두었다가 시험 고리에서 항목을 누른다(사용자가 트레이 메뉴를 고르는 것과 같은 길)
const { Tray } = require('electron');
let trayMenu = null;
const origSetMenu = Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu = function (m) { trayMenu = m; return origSetMenu.call(this, m); };

require(path.join(REPO, 'electron', 'main.cjs'));

// 시험 고리(127.0.0.1:3959): 본창을 사용자가 X 를 누른 것처럼 닫기(= 트레이로 숨김) · 보이기 · 상태
const wins = [];
app.on('browser-window-created', (_e, w) => wins.push(w));
require('http').createServer((req, res) => {
  const main = wins.find((w) => !w.isDestroyed() && !w.webContents.getURL().includes('mini=1'));
  const mini = wins.find((w) => !w.isDestroyed() && w.webContents.getURL().includes('mini=1'));
  if (req.url === '/close' && main) main.close();
  if (req.url === '/show' && main) { main.show(); main.focus(); }
  if (req.url === '/crash' && main) main.webContents.forcefullyCrashRenderer();   // 본창 화면이 죽음(메모리 부족 같은)
  if (req.url === '/minimize' && main) main.minimize();
  const mv = /^\/mini-move\?x=(-?\d+)&y=(-?\d+)$/.exec(req.url);   // 사용자가 미니 창을 끌어다 놓음
  if (mv && mini) { mini.setPosition(+mv[1] + 8, +mv[2] + 8); mini.emit('moved'); }   // 시험 좌표는 '카드 + 8' 가상 창(11/16~ 실제 창 = 카드)
  const dg = /^\/mini-drag\?x=(-?\d+)&y=(-?\d+)$/.exec(req.url);   // 끄는 도중(아직 안 놓음) — 손으로 옮길 때만 오는 will-move 와 함께
  if (dg && mini) { mini.emit('will-move', { preventDefault() {} }); mini.setPosition(+dg[1] + 8, +dg[2] + 8); }
  let clicked = null;
  const tm = /^\/tray\?label=(.+)$/.exec(req.url);
  if (tm && trayMenu) { const it = trayMenu.items.find((i) => i.label === decodeURIComponent(tm[1])); if (it) { it.click(); clicked = it.label; } }
  const minis = wins.filter((w) => !w.isDestroyed() && w.webContents.getURL().includes('mini=1')).length;
  res.end(JSON.stringify({ main: !!main && main.isVisible(), mini: !!mini && mini.isVisible(), miniBounds: mini ? (({ x, y, width, height }) => ({ x: x - 8, y: y - 8, width: width + 16, height: height + 16 }))(mini.getBounds()) : null, miniReal: mini ? mini.getBounds() : null, minis, mainMin: !!main && main.isMinimized(), miniTitle: mini ? mini.getTitle() : null, mainId: main ? main.id : null, clicked, tray: trayMenu ? trayMenu.items.map((i) => i.label) : null }));
}).listen(Number(process.env.HARNESS_HOOK_PORT || 3959), '127.0.0.1');
