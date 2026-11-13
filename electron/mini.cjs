// 미니 창(26.11.13~) — 본창을 트레이에 숨겨 두고 MCP 로 일을 맡길 때, 지금 돌고 있는 작업만 화면 구석에 띄운다.
// (아이디어: 전상필님 2026-11-13 "작업관리자 그래프를 구석에 박아 두듯이")
//
// 이 창은 데이터를 들고 있지 않다. 본창 화면이 보내는 요약(mini:state)을 받아 그리기만 한다 — 같은 기록(IndexedDB)을
// 두 창이 함께 쓰면 저장이 엉키므로 미니 창은 스토어를 아예 열지 않는다(src/main.tsx 가 ?mini=1 이면 App 을 들이지 않는다).
// 보내기 · 과금 코드 · 백업은 지금처럼 본창 화면이 한다(숨겨도 backgroundThrottling:false 라 제 속도로 돈다).
const { BrowserWindow, ipcMain, screen, Menu, app } = require('electron');
const path = require('path');
const fs = require('fs');

const MARGIN = 14;         // 화면 모서리와의 거리
// 위쪽 구석은 맨 위에서 이만큼 내려 앉는다 — 최대화한 창의 최소화 · 닫기 단추 줄(약 32px)을 항상 위 창이 덮지 않게.
// 기본 자리는 오른쪽 위다: 윈도우 알림이 오른쪽 아래에 떠서 미니 창을 가렸다(사용자 2026-11-13).
const TOP_CLEAR = 44;
const SIZES = ['pill', 'card', 'full'];
const OPACITY = [1, 0.85, 0.7, 0.55];

// ── 자리 나누기(26.11.13~) ───────────────────────────────────────────────────────────────
// 같은 PC 의 다른 Freewill 앱(나노바나나)도 자기 미니 창을 구석에 띄운다. 두 앱은 따로 관리되므로 화면을 합치지 않고,
// 같은 구석에 오면 겹치지 않게 위아래로 쌓기만 한다(사용자 2026-11-13 "각자 관리하되 교통정리만").
//   · 각 앱은 %APPDATA%\Freewill\mini-dock\<앱>.json 자기 파일 하나만 쓰고, 남의 파일은 읽기만 한다(서로 덮어쓰지 않음).
//   · 같은 화면 · 같은 구석이면 rank 가 작은 앱이 모서리 쪽(시댄스 0, 나노바나나 1). rank 가 같으면 이름순.
//   · 보이는 동안 2초마다 at(시각)을 새로 쓴다. 6초 넘게 멈춘 기록(꺼짐 · 죽음)은 없는 셈 친다.
//   · 칸을 지우거나 뜻을 바꾸지 않는다 — 더하기만 한다(두 앱의 배포 시점이 달라도 서로 읽을 수 있게).
// 나노바나나 쪽에 넘긴 규칙과 같은 내용: HANDOFF §6 미니 창.
const DOCK_GAP = 6;
const DOCK_STALE_MS = 6000;
const DOCK_BEAT_MS = 2000;

function initMini({ port, preload, getMain, showMain, onChange, dockName = 'seedance', dockRank = 0 }) {
  const dockDir = path.join(app.getPath('appData'), 'Freewill', 'mini-dock');
  const dockFile = path.join(dockDir, `${dockName}.json`);
  let win = null;
  let latest = null;              // 본창이 마지막으로 보낸 요약
  let prevActive = new Set();     // 직전 요약의 진행 중 작업 id — '새 작업' 을 알아보려고
  let prevWaiting = 0;
  let prevInLine = 0;             // 서버 작업함에서 차례를 기다리는 MCP 요청 수(아직 카드가 아님)
  let primed = false;             // 켠 직후 첫 요약에서는 띄우지 않는다(이미 돌던 작업은 '새 작업' 이 아니다)
  let size = { w: 316, h: 160 };
  let placing = false;
  // 언제 뜨고 언제 닫히나(사용자 2026-11-13 "언제 알림이 정리되는지도 꼼꼼히"):
  //   · 저절로 뜬 창(autoShown)은 목록이 비면 저절로 닫힌다 — 완료는 끝나고 90초, 실패는 10분 뒤 목록에서 빠진다(mini-feed).
  //   · 트레이에서 직접 켠 창은 직접 끌 때까지 둔다(작업 관리자 요약 보기처럼 박아 두는 용도).
  //   · 돌고 있는 일이 있을 때 사용자가 닫으면(dismissed) 그 일이 다 끝날 때까지는 새 요청이 와도 다시 안 띄운다
  //     — 에이전트가 줄줄이 보낼 때 닫자마자 또 뜨는 것을 막는다. 다 끝나거나, 본창을 트레이로 숨기면(직접 한 일) 풀린다.
  let autoShown = false;
  let dismissed = false;
  let room = 640;                 // 이 창이 쓸 수 있는 높이(화면 높이 − 여백 − 같은 구석 다른 앱 몫). 화면이 넘치면 목록이 스크롤된다.
  const MAX_H = 640;
  // 내 칸(slot) — 같은 구석의 다른 앱은 내 실제 높이가 아니라 이 칸만큼 비켜 앉는다. 생성이 몰려 내 높이가 오르내려도
  // 옆 창이 따라 들썩이지 않게(사용자 2026-11-13 "줄였을 때랑 늘렸을 때 최대치만 주는 거지 공간 딱 그냥 있게").
  //   카드: 기본값과 이번 실행에서 본 가장 큰 카드 높이 중 큰 쪽(처음 몇 번만 커질 수 있고 그 뒤로 안 변한다)
  //   펼침: 쓸 수 있는 최대 높이(room) · 알약: 알약 높이
  // 칸이 바뀌는 건 크기 단계를 바꿀 때 · 창이 열리고 닫힐 때뿐이다.
  const CARD_SLOT = 300;
  const maxSeen = { pill: 0, card: 0, full: 0 };
  const slotNow = () => {
    const s = prefs.size === 'full' ? room : prefs.size === 'card' ? Math.min(room, Math.max(CARD_SLOT, maxSeen.card)) : size.h;
    return Math.round(Math.max(s, Math.min(size.h, room)));
  };

  const prefsPath = path.join(app.getPath('userData'), 'mini-window.json');
  const prefs = { corner: 'tr', opacity: 1, size: 'card', auto: true };
  try { Object.assign(prefs, JSON.parse(fs.readFileSync(prefsPath, 'utf8'))); } catch { /* 처음 */ }
  if (!SIZES.includes(prefs.size)) prefs.size = 'card';
  const save = () => { try { fs.writeFileSync(prefsPath, JSON.stringify(prefs)); } catch { /* 못 써도 동작엔 지장 없음 */ } };

  const alive = () => !!win && !win.isDestroyed();
  const visible = () => alive() && win.isVisible();
  const display = () => (alive() ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay());
  const area = () => display().workArea;

  // 같은 구석에서 나보다 모서리 쪽에 앉는 다른 앱 창들의 높이 합(+간격).
  // 숫자는 논리 픽셀(Windows 배율 적용 뒤, Electron 과 같은 단위)이 약속이다. 상대가 물리 픽셀로 적었으면(배율 125% 등)
  // 그 화면 크기가 내 화면 × 배율과 맞으므로, 그때는 높이도 배율로 나눠 읽는다.
  const near = (p, q) => Math.abs(Number(p) - q) <= 1;
  const sameArea = (x, a, k) => !!x && near(x.x, a.x * k) && near(x.y, a.y * k) && near(x.width, a.width * k) && near(x.height, a.height * k);
  const dockOffset = () => {
    const a = area();
    const s = display().scaleFactor || 1;
    let off = 0;
    let names = [];
    try { names = fs.readdirSync(dockDir).filter((f) => f.endsWith('.json') && f !== `${dockName}.json`); } catch { return 0; }
    const now = Date.now();
    for (const f of names) {
      let e;
      try { e = JSON.parse(fs.readFileSync(path.join(dockDir, f), 'utf8')); } catch { continue; }   // 쓰는 중이면 다음 차례에
      if (!e || !e.visible || !(now - Number(e.at) < DOCK_STALE_MS) || e.corner !== prefs.corner) continue;
      const k = sameArea(e.area, a, 1) ? 1 : (s !== 1 && sameArea(e.area, a, s) ? s : 0);
      if (!k) continue;   // 다른 화면
      const before = Number(e.rank) < dockRank || (Number(e.rank) === dockRank && String(e.app) < dockName);
      const hh = Number(e.slot) > 0 ? Number(e.slot) : Number(e.h);   // 칸(slot)을 적었으면 칸만큼, 아니면 실제 높이만큼
      if (before && hh > 0) off += Math.round(hh / k) + DOCK_GAP;
    }
    return off;
  };
  let lastOff = 0;
  const writeDock = (isVisible) => {
    try {
      fs.mkdirSync(dockDir, { recursive: true });
      const b = alive() ? win.getBounds() : { x: 0, y: 0, width: size.w, height: size.h };
      const body = JSON.stringify({ app: dockName, rank: dockRank, corner: prefs.corner, x: b.x, y: b.y, w: b.width, h: b.height,
        visible: !!isVisible, at: Date.now(), area: area(), scale: display().scaleFactor || 1, slot: slotNow() });
      const tmp = `${dockFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, dockFile);   // 반쯤 쓴 파일을 남이 읽지 않게
    } catch { /* 못 써도 내 창은 그대로 돈다 */ }
  };

  // 고른 모서리에 붙인다. 크기가 바뀌어도 그 모서리를 기준으로 자라고, 같은 구석의 다른 앱 창만큼 비켜 앉는다.
  const place = () => {
    if (!alive()) return;
    const a = area();
    lastOff = dockOffset();
    // 남은 높이를 화면에 알려 목록을 그 안에 맞추게 한다(많이 돌려도 · 작은 화면이어도 · 아래에 다른 앱이 앉아도 화면 밖으로 안 나가게).
    const topGap = prefs.corner.includes('t') ? TOP_CLEAR : MARGIN;
    const r = Math.max(120, Math.min(MAX_H, Math.round(a.height - topGap - MARGIN - lastOff)));
    if (r !== room) { room = r; sendPrefs(); }
    const h = Math.min(size.h, room);
    const x = prefs.corner.includes('r') ? a.x + a.width - size.w - MARGIN : a.x + MARGIN;
    let y = prefs.corner.includes('b') ? a.y + a.height - h - MARGIN - lastOff : a.y + TOP_CLEAR + lastOff;
    y = Math.max(a.y, Math.min(y, a.y + a.height - h));   // 끝까지 밀려도 화면 안에는 남는다(그때는 겹치더라도 보이는 쪽을 고른다)
    placing = true;
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: size.w, height: h });
    setTimeout(() => { placing = false; }, 250);
    writeDock(win.isVisible());
  };
  // 보이는 동안: 살아 있다고 알리고(2초), 남이 커지거나 닫히면 따라 움직인다(1초).
  setInterval(() => { if (visible()) writeDock(true); }, DOCK_BEAT_MS);
  setInterval(() => { if (visible() && !placing && dockOffset() !== lastOff) place(); }, 1000);
  app.on('before-quit', () => writeDock(false));

  function sendPrefs() { if (alive()) win.webContents.send('mini:prefs', { size: prefs.size, room }); }

  const create = () => {
    win = new BrowserWindow({
      width: size.w, height: size.h,
      frame: false, transparent: true, hasShadow: false,          // 둥근 모서리 · 그림자는 화면이 그린다
      resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false,
      title: 'Seedance 미니',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setOpacity(prefs.opacity);
    // 창 제목은 'Seedance 미니' 로 둔다 — 페이지 <title> 이 본창과 같은 이름으로 덮어쓰면, 같은 구석을 쓰는 나노바나나가
    // 시댄스 미니 창을 크기로 짐작해야 했다(그쪽 데모 11/13). 제목은 창을 찾는 이름이라 바꾸지 않는다.
    win.on('page-title-updated', (e) => e.preventDefault());
    win.loadURL(`http://localhost:${port}/?mini=1`);
    win.webContents.on('did-finish-load', () => {
      sendPrefs();
      if (latest) win.webContents.send('mini:state', latest);
    });
    win.once('ready-to-show', () => { place(); win.showInactive(); writeDock(true); onChange?.(); });
    // 끌어서 놓으면 가까운 모서리로 붙는다(작업 관리자 요약 보기처럼 구석에 박아 두는 창).
    win.on('moved', () => {
      if (placing || !alive()) return;
      const b = win.getBounds();
      const a = area();
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      prefs.corner = (cy < a.y + a.height / 2 ? 't' : 'b') + (cx < a.x + a.width / 2 ? 'l' : 'r');
      save();
      place();
    });
    win.on('closed', () => { win = null; writeDock(false); onChange?.(); });
  };

  // auto=true 는 새 작업 · 본창 숨김으로 저절로 뜬 것, false 는 사용자가 트레이에서 켠 것.
  const show = (auto = false) => {
    if (visible()) { if (!auto) autoShown = false; return; }
    autoShown = auto;
    if (!auto) dismissed = false;
    if (!alive()) { create(); return; }
    place(); win.showInactive(); writeDock(true); onChange?.();
  };
  const hide = () => { if (alive() && win.isVisible()) { win.hide(); writeDock(false); onChange?.(); } };
  // 사용자가 닫음(× · 우클릭 메뉴 · 트레이). 돌고 있는 일이 있으면 그 일이 끝날 때까지 다시 안 띄운다.
  const close = () => { dismissed = hasActive(latest); hide(); };

  const hasActive = (s) => !!s && (s.tasks.some((t) => t.status === 'queued' || t.status === 'running') || (s.running || 0) + (s.queued || 0) + (s.inLine || 0) > 0 || s.waiting > 0);
  const mainHidden = () => {
    const m = getMain();
    return !m || m.isDestroyed() || !m.isVisible() || m.isMinimized();
  };

  ipcMain.on('mini:state', (e, snap) => {
    const m = getMain();
    if (!m || m.isDestroyed() || e.sender !== m.webContents || !snap || !Array.isArray(snap.tasks)) return;   // 본창 화면만 보낸다
    latest = snap;
    const active = new Set(snap.tasks.filter((t) => t.status === 'queued' || t.status === 'running').map((t) => t.id));
    const fresh = [...active].some((id) => !prevActive.has(id)) || (snap.waiting || 0) > prevWaiting || (snap.inLine || 0) > prevInLine;
    prevActive = active;
    prevWaiting = snap.waiting || 0;
    prevInLine = snap.inLine || 0;
    if (!hasActive(snap)) dismissed = false;   // 하던 일이 다 끝났다 — 다음 새 일부터는 다시 띄운다
    if (primed && prefs.auto && fresh && !dismissed && mainHidden() && !visible()) show(true);
    primed = true;
    if (alive()) win.webContents.send('mini:state', snap);
    // 저절로 뜬 창은 목록이 비면 저절로 닫는다(완료 90초 · 실패 10분 뒤 비워진다).
    if (autoShown && visible() && snap.tasks.length === 0 && !hasActive(snap)) hide();
  });

  const popupMenu = () => {
    if (!alive()) return;
    const label = { pill: '알약', card: '카드', full: '펼침' };
    Menu.buildFromTemplate([
      { label: '본창 열기', click: () => showMain() },
      { type: 'separator' },
      ...SIZES.map((s) => ({ label: `크기: ${label[s]}`, type: 'radio', checked: prefs.size === s, click: () => { prefs.size = s; save(); sendPrefs(); } })),
      { type: 'separator' },
      ...OPACITY.map((o) => ({ label: `투명도 ${Math.round(o * 100)}%`, type: 'radio', checked: Math.abs(prefs.opacity - o) < 0.01, click: () => { prefs.opacity = o; save(); if (alive()) win.setOpacity(o); } })),
      { type: 'separator' },
      { label: '본창을 숨겼을 때 새 작업이 생기면 띄우기', type: 'checkbox', checked: prefs.auto, click: () => { prefs.auto = !prefs.auto; save(); onChange?.(); } },
      { label: '미니 창 닫기', click: () => close() },
    ]).popup({ window: win });
  };

  ipcMain.on('mini:action', (e, name, p) => {
    if (!alive() || e.sender !== win.webContents) return;   // 미니 창만 보낸다
    if (name === 'resize' && p) {
      const w = Math.max(120, Math.min(460, Math.round(Number(p.w) || 0)));
      const h = Math.max(40, Math.min(MAX_H, Math.round(Number(p.h) || 0)));
      // 화면이 '이 크기로 그렸다' 고 함께 알려 줄 때만 칸 계산에 넣는다 — 크기를 바꾸는 순간 옛 크기의 높이가 섞이지 않게.
      if (SIZES.includes(p.size) && p.size === prefs.size) maxSeen[p.size] = Math.max(maxSeen[p.size], h);
      if (w !== size.w || h !== size.h) { size = { w, h }; place(); }
    } else if (name === 'open') {
      showMain();
    } else if (name === 'goto' && p && typeof p.projectId === 'string' && typeof p.msgId === 'string') {
      showMain();
      const m = getMain();
      if (m && !m.isDestroyed()) m.webContents.send('mini:goto', { projectId: p.projectId, msgId: p.msgId });
    } else if (name === 'size' && SIZES.includes(p)) {
      prefs.size = p; save(); sendPrefs();
    } else if (name === 'ready') {
      // 화면이 듣기 시작했다 — did-finish-load 때 보낸 첫 요약은 React 가 뜨기 전이라 놓친다. 지금 것을 다시 준다.
      sendPrefs();
      if (latest) win.webContents.send('mini:state', latest);
    } else if (name === 'menu') {
      popupMenu();
    } else if (name === 'close') {
      close();
    }
  });

  return {
    show: () => show(false), hide: close, visible,
    toggle: () => (visible() ? close() : show(false)),
    auto: () => prefs.auto,
    setAuto: (v) => { prefs.auto = !!v; save(); },
    // 본창을 트레이로 숨겼을 때 — 돌고 있는 작업이 있으면 바로 띄운다. 닫아 둠(dismissed)은 '새 요청이 와서 저절로 뜨는 것' 만
    // 막는다. 본창을 숨기는 건 사용자가 직접 한 일이고 미니 창이 있는 이유라, 닫아 둠을 풀고 띄운다(11/13 손 작업 시험에서 발견).
    onMainHidden: () => { dismissed = false; if (prefs.auto && hasActive(latest)) show(true); },
  };
}

module.exports = { initMini };
