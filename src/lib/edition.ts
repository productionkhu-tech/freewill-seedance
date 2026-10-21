// 개인판(26.10.2005~) — 같은 소스에서 설치 파일을 하나 더 만든다(electron-builder.personal.yml).
//
// 판을 정하는 곳은 하나다: 설치본의 package.json `seedanceEdition`(빌드 설정의 extraMetadata 가 넣는다).
// main.cjs 가 그 값을 읽어 서버(process.env.SEEDANCE_EDITION)와 화면(preload → window.electronAPI.edition)에 알린다.
// 화면 빌드(dist)와 서버 빌드(server.cjs)는 두 판이 같은 파일이다 — 빌드를 두 번 하다 판이 엇갈릴 길을 없앴다.
//
// 개인판은 회사 것을 쓰지 않는다: 프로젝트 코드 · 시트 보고 · 게이트웨이 · NCP 보관 · 회사 R2 가 없고, 키는 사용자가
// 설정 › 내 키 에서 넣는다(PC 에 암호화 저장). 회사 팀 키는 받지 않는다(server.ts personalKeyRefusal).
//
// 이 파일은 server.ts 도 읽는다 — React · 스토어를 들이지 말 것(서버 번들에 화면이 딸려 간다).

/**
 * 개인판의 '프로젝트 코드' 자리. 보내기 · 권한 · 에이전트 코드는 코드가 있어야 움직이므로, 개인판은 이 한 줄을 늘 고른
 * 상태로 둔다(store.ts). 서버는 개인판이면 이 값을 보지 않고, 회사판이면 이 id 를 받지 않는다(시트에 '개인' 줄이 생기지 않게).
 */
export const PERSONAL_BILLING = {
  key: '__personal__',
  id: '__personal__',
  project: '개인',
  status: '진행',
  allow4k: true,
  allow25: true,
} as const;

/** 화면에서 지금 개인판인가. preload 가 알려 준 값만 믿는다(주소창 쿼리 · 저장값으로는 못 바꾼다). */
export function isPersonalEdition(): boolean {
  try { return (globalThis as any).electronAPI?.edition === 'personal'; } catch { return false; }
}
export const PERSONAL = isPersonalEdition();

/** 문서 폴더의 백업 폴더 이름(main.cjs BACKUP_DIR 과 같은 규칙) — 화면 안내 문구용. */
export const BACKUP_FOLDER = PERSONAL ? 'Freewill Seedance Personal Backup' : 'Freewill Seedance Backup';

/** 설치본 이름 — 화면 문구용. */
export const APP_NAME = PERSONAL ? 'Freewill Seedance Personal' : 'Freewill Seedance 2.0';
