<div align="center">

# Freewill Seedance 2.0

BytePlus Seedance + Gemini Omni Flash 기반 영상 생성 데스크탑 앱

</div>

---

## 문서는 하나다 — **[HANDOFF.md](./HANDOFF.md)**

구조 · 배포 · 업데이트 · API 규칙 · 데이터/백업 · 불변 규칙 · 알려진 한계까지
**인수인계에 필요한 전부**가 그 파일 하나에 있다. 여기부터 읽으면 된다.

| 궁금한 것 | 어디 |
|---|---|
| 뭘 건드리면 업데이트가 깨지나 | HANDOFF §2 |
| 맥에서 어떻게 돌리나 | HANDOFF §12 · [맥_실행_가이드.md](./맥_실행_가이드.md) |
| 생성 요청 규칙 (모드·에셋 한도·4K·2.5) | HANDOFF §5 |
| 프로젝트가 어디 저장되나 | HANDOFF §4 |
| 외부 서비스·시트·GAS 연결 | HANDOFF §11 |

---

## 실행

**윈도우** — 설치본(exe)을 쓴다. 자동 업데이트된다.

**맥 / 개발** — 소스에서 실행한다:

```bash
npm install
# .env 작성 (HANDOFF §12 — 필수 5줄)
npm run dev        # → http://localhost:3000
```

빌드·배포는 HANDOFF §2-3.

---

<sub>Public 저장소다. 키·토큰·데모 엔드포인트 ID 를 코드나 문서에 넣지 말 것.</sub>
