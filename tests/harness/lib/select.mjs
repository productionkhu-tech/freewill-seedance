// 바뀐 파일을 보고 무엇을 얼마나 확인할지 정한다(글: 위험에 따라 확인의 양을, 모르면 올려 잡는다).
//   low   — 글 · 문서 · 시험 도구        medium — 한 화면        high — 보내기 · 저장 · 서버 · 키 · 게이트웨이(전부)
// 여기 없는 파일은 high. 시험을 새로 만들면 CASES 와 RULES 에 같이 적는다(안 적으면 verify 가 알려 준다).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO, HARNESS } from './app.mjs';

// 걸리는 시간(초) — 긴 것부터 나눠 맡기려고. 실제 시간은 마찰 기록에서 다시 읽는다.
export const CASES = { modes: 390, 'auto-certify': 250, evict: 150, cancel: 140, 'same-picture': 125, 'video-record': 100, 'panel-badge': 95, 'evict-watch': 95, 'panel-edits': 55, frames: 30, 'video-badge': 25, 'busy-line': 105, 'error-card': 40 };
const ALL = Object.keys(CASES);
const SEND = ['modes', 'auto-certify', 'frames', 'cancel', 'same-picture', 'video-record', 'busy-line'];
const PANEL = ['panel-badge', 'panel-edits', 'video-badge', 'same-picture'];
const RULES = [
  [/^(HANDOFF|README|.*)\.md$|^\.archify\/|^\.gitignore$/, 'low', []],
  [/^tests\/harness\/cases\/([\w-]+)\.mjs$/, 'low', (m) => (CASES[m[1]] ? [m[1]] : [])],
  [/^tests\/harness\//, 'low', ['video-badge']],
  [/^src\/lib\/busy-line\.ts$/, 'medium', ['busy-line', 'cancel']],
  [/^src\/lib\/utils\.ts$/, 'high', ALL],
  [/^src\/lib\/same-pixels\.ts$/, 'medium', ['same-picture', 'auto-certify', 'panel-edits', 'frames']],
  [/^src\/lib\/translate-error\.ts$/, 'medium', ['auto-certify', 'error-card']],
  [/^src\/components\/SettingsPanel\.tsx$/, 'medium', PANEL],
  [/^src\/components\/ElementLibrary\.tsx$/, 'medium', ['panel-badge', 'evict']],
  [/^src\/components\/Sidebar\.tsx$/, 'medium', ['video-record']],
  [/^src\/components\/ChatArea\.tsx$/, 'medium', ['auto-certify', 'cancel', 'panel-edits', 'same-picture', 'busy-line', 'error-card']],
  [/^src\/App\.tsx$/, 'medium', ['evict-watch', 'video-record']],
  [/^src\/index\.css$|^src\/components\//, 'medium', ['panel-badge', 'video-badge']],
  [/^src\/lib\/(bp-certify|bp-assets)\.ts$/, 'high', ALL],
  [/^src\/lib\/send-request\.ts$|^src\/store\.ts$/, 'high', ALL],
  [/^src\/lib\//, 'medium', SEND],
  [/^(server\.ts|electron\/|worker\/|package(-lock)?\.json|vite\.config\.ts|electron-builder.*\.yml|scripts\/|public\/|index\.html)/, 'high', ALL],
];
export const RISKS = ['low', 'medium', 'high'];
const git = (...a) => execFileSync('git', ['-C', REPO, '-c', 'core.quotepath=false', '-c', 'core.safecrlf=false', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
/** 기준(커밋)과 달라진 파일 — 아직 git 이 모르는 새 파일도. */
export function changedFiles(base = 'HEAD') {
  const a = git('diff', '--name-only', base).split('\n'), b = git('ls-files', '--others', '--exclude-standard').split('\n');
  return [...new Set([...a, ...b].map((x) => x.trim()).filter(Boolean))].sort();
}
export const diffText = (base = 'HEAD') => git('diff', '-U0', base) + changedFiles(base).filter((f) => { try { git('ls-files', '--error-unmatch', f); return false; } catch { return /\.(ts|tsx|cjs|mjs|js|yml|json)$/.test(f); } }).map((f) => `\n+++ b/${f}\n` + fs.readFileSync(path.join(REPO, f), 'utf8').split('\n').map((l) => `+${l}`).join('\n')).join('');
export function select(files) {
  const cases = new Set(), why = [];
  let risk = 'low';
  for (const f of files) {
    const hit = RULES.map(([re, r, c]) => { const m = re.exec(f); return m && [r, typeof c === 'function' ? c(m) : c]; }).find(Boolean) || ['high', ALL];
    if (RISKS.indexOf(hit[0]) > RISKS.indexOf(risk)) risk = hit[0];
    hit[1].forEach((c) => cases.add(c));
    why.push([f, hit[0], hit[1].length === ALL.length ? '전부' : hit[1].join(' ') || '없음']);
  }
  return { risk, cases: ALL.filter((c) => cases.has(c)), why };
}
/** cases 폴더에는 있는데 위 표에 없는 시험 */
export const unlisted = () => fs.readdirSync(path.join(HARNESS, 'cases')).filter((f) => f.endsWith('.mjs')).map((f) => f.slice(0, -4)).filter((c) => !CASES[c]);
