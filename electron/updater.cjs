// 업데이트 흐름 (26.10.306~) — 켤 때 · 트레이의 '업데이트 확인' · 켜 둔 동안 3시간마다.
//
// main.cjs 에서 떼어 둔 이유: 여기를 잘못 건드리면 팀 전체가 업데이트를 못 받는다. 그래서 Electron 없이 가짜
// autoUpdater 로 경우마다 시험할 수 있게 바깥 것(알림 · 대화상자 · 창 제목 · 트레이 메뉴)을 전부 넘겨받는다.
// ★ electron-builder.yml 의 files 는 명시 목록이다 — 이 파일이 거기 빠지면 패키지 앱이 켜지자마자 죽는다.
//
// 세 가지 확인 방식:
//   launch     — 켤 때. 있으면 알리고 받아서 바로 다시 시작한다(예전 그대로). 켜자마자라 진행 중인 일이 거의 없다.
//   manual     — 트레이에서 '업데이트 확인' 을 눌렀다. 사용자가 지금 하겠다고 한 것이라 같은 흐름이다. 창이
//                트레이에 숨어 있을 수 있어 막는 대화상자 대신 알림으로 알린다. 없으면 '최신 버전' 이라고 알린다.
//   background — 켜 둔 동안 3시간마다. 조용히 받아 두기만 한다. 일하는 중에 앱이 저절로 꺼지면 안 된다 — 옴니
//                생성(동기 요청)은 끊기면 사라진다. 다 받으면 트레이 메뉴가 '업데이트 설치 — 다시 시작' 으로 바뀌고
//                한 번 알린다. 누르면 그때 설치하고, 안 누르면 앱을 끌 때 조용히 설치된다(autoInstallOnAppQuit
//                → install(isSilent=true) — 설치 마법사 창은 안 뜬다).

const BACKGROUND_EVERY_MS = 3 * 60 * 60 * 1000;

/**
 * @param {object} o
 * @param {import('electron-updater').AppUpdater} o.autoUpdater
 * @param {boolean} o.isDev
 * @param {string} o.currentVersion
 * @param {(...a: any[]) => void} o.log
 * @param {(title: string, body: string) => void} o.notify
 * @param {(version: string) => void} o.showLaunchDialog   켤 때 '새 버전을 설치합니다' 안내(예전 대화상자)
 * @param {(percent: number) => void} o.setWindowProgress  작업표시줄 진행 막대 · 창 제목
 * @param {() => void} o.beforeInstall                      설치 직전(창 제목 · 알림 · app.isQuitting)
 * @param {() => void} o.onChange                           트레이 메뉴를 다시 그리라는 신호
 */
function createUpdater(o) {
  let mode = 'launch';          // 지금 진행 중인 확인이 어떤 방식으로 시작됐나
  let state = 'idle';           // idle | checking | downloading | ready
  let percent = 0;
  let readyVersion = null;
  const set = (s) => { state = s; o.onChange(); };

  o.autoUpdater.on('update-available', (info) => {
    const v = info && info.version;
    o.log(`update-available v${v} (${mode})`);
    if (mode === 'launch') o.showLaunchDialog(v);
    else if (mode === 'manual') o.notify('업데이트', `새 버전 v${v} 을 내려받습니다. 다 받으면 앱이 꺼졌다가 자동으로 다시 켜집니다.`);
    percent = 0;
    set('downloading');
    Promise.resolve().then(() => o.autoUpdater.downloadUpdate()).catch((e) => o.log('downloadUpdate failed', e));
  });

  o.autoUpdater.on('update-not-available', () => {
    set('idle');
    if (mode === 'manual') o.notify('최신 버전이에요', `지금 쓰는 v${o.currentVersion} 이 최신입니다.`);
  });

  o.autoUpdater.on('download-progress', (p) => {
    const n = Math.max(0, Math.min(100, Math.round((p && p.percent) || 0)));
    if (mode !== 'background') o.setWindowProgress((p && p.percent) || 0);   // 숨은 다운로드는 창 제목을 건드리지 않는다
    if (n !== percent) { percent = n; o.onChange(); }
  });

  o.autoUpdater.on('update-downloaded', (info) => {
    const v = info && info.version;
    o.log(`update-downloaded v${v} (${mode})`);
    if (mode === 'background') {
      readyVersion = v;
      set('ready');
      o.notify('업데이트 준비됨', `새 버전 v${v} 을 받아 뒀어요. 트레이 아이콘 메뉴의 '업데이트 설치'를 누르거나, 앱을 끌 때 설치됩니다.`);
      return;
    }
    install();
  });

  o.autoUpdater.on('error', (err) => {
    o.log('error', (err && err.message) || err);
    set(readyVersion ? 'ready' : 'idle');   // 받아 둔 게 있으면 그건 그대로 설치할 수 있다
    if (mode === 'manual') o.notify('업데이트 확인 실패', '인터넷 연결을 확인한 뒤 다시 눌러 주세요.');
  });

  function install() {
    o.beforeInstall();
    // ★ (true, true) = 조용히 설치하고 끝나면 다시 띄운다. 인자 없이 부르면 설치 마법사 창이 뜬다(main.cjs 주석 참고).
    o.autoUpdater.quitAndInstall(true, true);
  }

  function check(m) {
    if (o.isDev) {
      if (m === 'manual') o.notify('업데이트', '개발 실행에서는 업데이트를 확인하지 않습니다.');
      return;
    }
    if (state === 'checking' || state === 'downloading') return;   // 이미 하는 중
    if (state === 'ready') { if (m === 'manual') install(); return; }
    mode = m;
    set('checking');
    try {
      Promise.resolve(o.autoUpdater.checkForUpdates()).catch((e) => {
        o.log('checkForUpdates failed', e);
        // 대개 'error' 이벤트도 같이 온다. 안 오는 경우를 위해 멈춘 상태로 두지 않는다.
        if (state === 'checking') { set('idle'); if (mode === 'manual') o.notify('업데이트 확인 실패', '인터넷 연결을 확인한 뒤 다시 눌러 주세요.'); }
      });
    } catch (e) {
      o.log('checkForUpdates threw', e);
      set('idle');
    }
  }

  // 트레이 메뉴의 업데이트 항목(Menu.buildFromTemplate 에 그대로 들어간다).
  function menuItem() {
    if (state === 'checking') return { label: '업데이트 확인 중…', enabled: false };
    if (state === 'downloading') return { label: `업데이트 내려받는 중 ${percent}%`, enabled: false };
    if (state === 'ready') return { label: `업데이트 설치 — 다시 시작 (v${readyVersion})`, click: () => check('manual') };
    return { label: `업데이트 확인 (지금 v${o.currentVersion})`, click: () => check('manual') };
  }

  return { check, menuItem, getState: () => ({ state, mode, percent, readyVersion }) };
}

module.exports = { createUpdater, BACKGROUND_EVERY_MS };
