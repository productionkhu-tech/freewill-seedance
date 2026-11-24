// 앱 코드의 도장 — 결과가 '어느 코드에서 나왔나'. 시험 도중 바뀌면 그 결과는 무효.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPO } from './app.mjs';

const ROOTS = ['src', 'electron', 'worker', 'public'];
const TOP = /\.(ts|tsx|cjs|mjs|js|json|html)$/;   // 맨 위의 코드도(server.ts 가 ncp.ts 를 부른다)
export function stampOf(repo = REPO) {
  const list = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(ts|tsx|css|cjs|mjs|js|html|json)$/.test(e.name)) list.push(p); } };
  for (const r of ROOTS) if (fs.existsSync(path.join(repo, r))) walk(path.join(repo, r));
  for (const f of fs.readdirSync(repo)) if (TOP.test(f) && fs.statSync(path.join(repo, f)).isFile()) list.push(path.join(repo, f));
  const h = crypto.createHash('sha256');
  // 줄 끝(CRLF/LF)은 git 이 바꾸므로 빼고 본다 — 커밋만 해도 도장이 달라지지 않게
  for (const f of list.map((x) => path.relative(repo, x).split(path.sep).join('/')).sort()) { h.update(`\0${f}\0`); h.update(fs.readFileSync(path.join(repo, f), 'utf8').split('\r\n').join('\n')); }
  return h.digest('hex').slice(0, 10);
}
