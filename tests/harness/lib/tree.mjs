// 앱 코드의 사본(저장소는 안 건드림) — 커밋된 코드, 또는 지금 코드를 조금 바꾼 것을 시험 앱으로 띄우려고.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA, REPO } from './app.mjs';

const git = (...a) => execFileSync('git', ['-C', REPO, '-c', 'core.quotepath=false', ...a], { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
const NEED = /^(src|electron|worker|public)\/|^[^/]+\.(ts|tsx|cjs|mjs|js|json|html)$/;
/** ref: 'work'(지금 코드) 또는 커밋. 만든 폴더를 돌려준다. node_modules 는 이어 붙인다(복사 안 함). */
export function makeTree(name, ref = 'work') {
  const dir = path.join(DATA, 'trees', name);
  const link = path.join(dir, 'node_modules');
  const trees = path.join(DATA, 'trees');
  if (fs.existsSync(dir) && !dropTree(dir)) throw new Error(`옛 사본을 못 지움: ${name}`);
  // 지난 번에 못 지운 사본 정리(하루 넘은 것만 — 다른 실행이 쓰는 중일 수 있다)
  if (fs.existsSync(trees)) for (const d of fs.readdirSync(trees)) { const p = path.join(trees, d); try { if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600_000) dropTree(p); } catch { /* 다음에 */ } }
  fs.mkdirSync(dir, { recursive: true });
  const files = (ref === 'work' ? git('ls-files', '-co', '--exclude-standard') : git('ls-tree', '-r', '--name-only', ref)).split('\n').filter((f) => NEED.test(f));
  for (const f of files) {
    const to = path.join(dir, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (ref === 'work') { if (fs.existsSync(path.join(REPO, f))) fs.copyFileSync(path.join(REPO, f), to); } else fs.writeFileSync(to, execFileSync('git', ['-C', REPO, 'show', `${ref}:${f}`], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }));
  }
  fs.symlinkSync(path.join(REPO, 'node_modules'), link, 'junction');
  return dir;
}
/** 사본 지우기 — 이어 붙인 node_modules 부터 떼고(떼졌는지 본 뒤에만) 지운다. 아직 쥐고 있으면 두고 다음 번에. */
export function dropTree(dir) {
  const link = path.join(dir, 'node_modules');
  try { if (fs.lstatSync(link, { throwIfNoEntry: false })) fs.unlinkSync(link); } catch { return false; }
  if (fs.lstatSync(link, { throwIfNoEntry: false })) return false;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); return true; } catch { return false; }
}
/** 사본의 한 곳만 바꾼다. 딱 한 번 나와야 한다(아니면 무엇을 망가뜨렸는지 모른다). */
export function mutate(dir, file, find, replace) {
  const p = path.join(dir, file);
  const raw = fs.readFileSync(p, 'utf8'), crlf = raw.includes('\r\n'), s = crlf ? raw.split('\r\n').join('\n') : raw;
  const n = s.split(find).length - 1;
  if (n !== 1) throw new Error(`${file} 에 '${find.slice(0, 60)}' 가 ${n}번 — 망가뜨릴 자리를 다시 적어야 함`);
  const out = s.replace(find, () => replace);
  fs.writeFileSync(p, crlf ? out.split('\n').join('\r\n') : out);
}
