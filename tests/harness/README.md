# 시험 하네스

진짜 앱(Electron + 서버 + 화면)을 따로 띄우고, 바깥(BytePlus · 시트 · R2 · NCP)은 가짜로, 게이트웨이는 진짜 코드로 시험한다. 과금 없음.
저장소 밖 임시 폴더(`%TEMP%\fw-harness`)에 데이터를 두고, 실제 앱(3000)과 다른 세션의 앱은 건드리지 않는다. 설치 파일에는 들어가지 않는다.

만든 까닭: 11/24~25 에 예전 코드의 통과를 지금 코드 결과처럼 말했고, 재 보지 않은 원인을 사실처럼 말했다. 그래서 **결과마다 코드 도장**을 붙인다.
참고한 글: claude.dev "How the Claude Code team thinks about verification" · runway.com "Building a software factory".

## 쓰는 법 (저장소 폴더에서)

| 하려는 것 | 명령 |
|---|---|
| 바뀐 것만 확인 (보통) | `node tests/harness/verify.mjs` |
| 무엇을 돌릴지만 보기 | `node tests/harness/verify.mjs --plan` |
| 전부 | `node tests/harness/verify.mjs --all` |
| 하나만 | `node tests/harness/verify.mjs --only frames` |
| 지금 코드에 결과가 다 있나 (배포 전) | `node tests/harness/verify.mjs --gate` |
| 옛 코드와 보내는 내용 비교 | `node tests/harness/compare-send.mjs` |
| 시험이 정말 잡나 (일부러 망가뜨리기) | `node tests/harness/break-check.mjs` |
| 어디서 자주 막히나 | `node tests/harness/lib/friction.mjs` |
| 한꺼번에 많이 보내 보기(재기만) | `node tests/harness/bulk.mjs --videos 60 --rate 120 --cap 20 --task 40` |
| 사람이 직접 만져 보기 | `node tests/harness/play.mjs` (끄기 `--stop`) |

## 지킬 것

1. **결과는 코드 도장과 같이 말한다.** 코드가 바뀌면 그 전 결과는 무효다. 안 돌린 것은 "안 함" 이라고 말한다.
2. **흔들리는 시험을 다시 돌려 넘기지 않는다.** 건너뛰기 · 기다리기 늘리기도 안 된다. 원인을 못 찾으면 빼고 아래 '뺀 시험' 에 이유를 적는다.
3. **세 번 고쳐도 안 되면 멈추고 사람에게 말한다.** `friction.mjs` 가 세 번 넘게 막힌 곳을 짚는다.
4. **원인은 기록을 보고 말한다.** 실패하면 `.results/<도장>-evidence` 의 화면 · 상태 · 바로 앞에 맞은 확인부터 본다.
5. **시험이 앱을 이기려면 시험도 시험한다.** 새 기능을 넣으면 `break-check.mjs` 에 망가뜨릴 곳을 하나 넣는다.
6. **보내는 내용을 바꾸면** `compare-send.mjs` 가 말한다. 일부러 바꾼 것만 `approved.json` 에 이유와 함께.
7. 프로세스는 이 하네스가 켠 것만 끈다(켤 때 적은 번호 + 명령줄의 표). 포트를 모르는 것이 쓰면 다른 슬롯을 쓴다.

## 짜임

- `verify.mjs` 고르고 돌리고 적는다 · `lib/select.mjs` 바뀐 파일 → 위험 · 시험(모르는 파일은 전부) · `lib/checklist.mjs` 났던 사고 중 바뀐 줄에 걸리는 것만 묻는다
- `lib/app.mjs` 시험 앱 켜고 끄기 · `lib/cdp.mjs` 화면에 붙기 · `lib/t.mjs` 확인과 증거 · `lib/stamp.mjs` 코드 도장 · `lib/tree.mjs` 코드 사본
- `fakes/` 가짜 BytePlus · 게이트웨이 · 앱 띄우기 · `cases/` 시험 · `lib/fixtures.mjs` 사진 · 영상 만들기(ffmpeg)
- 새 시험: `cases/이름.mjs` 를 쓰고 `lib/select.mjs` 의 CASES · RULES 에 적는다

## 알아낸 것

- `Promise was collected`: 화면이 새로 고쳐진 게 아니다(그건 `Inspected target navigated`). 기다리던 약속을 아무도 안 붙들면 메모리 정리 때 끊긴다(11/25 실험). `lib/cdp.mjs` 가 붙들어 둔다. 처음 겪은 병렬 실행에서 **왜** 붙든 것이 없어졌는지는 아직 모른다 — 다시 나면 무엇을 기다렸는지 적힌다.
- 앱이 안 뜨던 것: Node 의 `npx.cmd` 가 가끔 실패한다(네 번 중 두 번). 시험에서는 npx 를 거치지 않는다(10번 중 10번 뜸).
- 화소가 같은 사진은 이제 같은 사진이다 — 파일 끝에 글자를 붙여 '다른 사진' 을 만들지 말 것(`paintCorner`).

- 끄기: 앱 본체가 먼저 죽으면 `taskkill /T` 로는 서버가 남았다(11/25). 자손을 먼저 적고 하나씩 끈다 — 본체만 죽이는 상황을 세 번 만들어 확인.
- 망가뜨리기는 **정말 해로운 것**으로. 첫 실행에서 '못 잡음' 2건은 시험이 약한 게 아니라 망가뜨린 자리가 무해했다(바꿔도 결과가 같음). 못 잡았다고 시험부터 고치지 말고 자리부터 볼 것.
- 화면 시계를 빠르게 돌리면(`busy-line`) 저장(마지막 변화 1.5초 뒤)이 계속 밀린다 — 다시 띄우기 전에 `flushPersist`. 실패 때 시각을 찍어 확인했다(11/25).
- 앞 시험에서 **인증한 사진을 다시 쓰면 R2 주소가 안 실린다**(에셋으로 나감) — 'R2 를 안 지움' 같은 확인이 헛통과한다. 실렸는지부터 확인한다(11/25).
- 화면 밖 카드는 앱이 배치를 건너뛴다(`content-visibility`) — 넘침 · 글자를 그대로 재면 **안 그린 것을 통과로 센다**. 시험에서는 모두 그리게 하고 높이도 확인한다(11/25 헛통과).
- 한 번 잡았다고 늘 잡는 것이 아니다 — '저마다 물어봄' 은 우연히 같은 순서가 나와 못 잡은 적이 있다. 순서가 아니라 원인(묻는 간격)을 본다(11/25).

## 뺀 시험

없음.

## 아직 못 하는 것

- 설치본(설치 파일)으로 끝에서 끝까지 · 진짜 BytePlus 에서 지워진 에셋 · 옴니(진짜 구글로 나간다)
