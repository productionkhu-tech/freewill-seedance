# Seedance 2.0 Studio

> **경고: 이 프로젝트는 급조된 불안정한 버전입니다. 프로덕션 환경에서의 사용을 권장하지 않습니다.**

Volcengine Ark API 기반 Seedance 2.0 영상 생성 웹 앱입니다.

## 주요 기능

- **텍스트/이미지 → 영상 생성** — Seedance 2.0 / 2.0 Fast 모델 지원
- **레퍼런스 모드** — 이미지·영상·오디오 참조 첨부 (첫 프레임 / 첫+끝 프레임)
- **실시간 비용 추정** — 모델·해상도·길이에 따른 CNY 단가 계산
- **비동기 태스크 관리** — 자동 폴링, 로컬스토리지 영속성
- **그리드/리스트 뷰** — 생성된 영상 목록 전환
- **인터넷 검색 토글** — 프롬프트 기반 웹 검색 참조 옵션

## 기술 스택

| 항목 | 기술 |
|------|------|
| 프레임워크 | Next.js 14 (App Router) |
| UI | React 18 + Tailwind CSS |
| 상태관리 | Zustand |
| 아이콘 | Lucide React |
| 언어 | TypeScript |

## 시작하기

```bash
npm install
npm run dev
```

`http://localhost:3000` 에서 앱이 실행됩니다.

## API 키 설정

앱 최초 실행 시 온보딩 화면에서 Volcengine Ark API 키를 입력합니다. 키는 브라우저 로컬스토리지에만 저장되며, 서버로 전송 시 요청 헤더를 통해 전달됩니다. 소스 코드에 하드코딩된 키는 없습니다.

## 프로젝트 구조

```
src/
├── app/
│   ├── api/
│   │   ├── generate/route.ts   # 영상 생성 요청 프록시
│   │   ├── task/[id]/route.ts  # 태스크 상태 조회
│   │   └── upload/route.ts     # 파일 업로드 (Volcengine Files API)
│   ├── globals.css
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── GenerateView.tsx        # 메인 뷰 (프롬프트 입력, 비용 계산)
│   ├── Header.tsx
│   ├── ModelParams.tsx         # 모델 파라미터 설정 패널
│   ├── Onboarding.tsx          # API 키 입력 온보딩
│   ├── ReferenceUpload.tsx     # 레퍼런스 에셋 업로드
│   └── VideoResult.tsx         # 생성 결과 표시 (그리드/리스트)
└── lib/
    ├── api.ts                  # 클라이언트 API 호출
    ├── store.ts                # Zustand 전역 상태
    └── types.ts                # 타입 정의, 모델 목록, 비용 계산
```

## 알려진 제한사항

- Volcengine API의 영상/오디오 참조는 **웹 URL만 지원** (로컬 파일 직접 첨부 제한)
- Asset Service (`Asset://` URI) 사용 시 Volcengine 콘솔에서 별도 활성화 필요
- 인물 이미지 참조 시 Volcengine의 얼굴 감지 정책에 의해 차단될 수 있음
- 급조된 프로젝트로 에러 핸들링 및 엣지 케이스 처리가 불완전함

## 라이선스

MIT
