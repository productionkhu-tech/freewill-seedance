// BytePlus 에셋 레퍼런스(asset://) — 한 곳에서 알아보고 다듬는다(26.11.2301~).
//
// 왜: Seedance 2.0 · 2.5 는 실존 인물 얼굴이 든 레퍼런스 이미지 · 영상을 바로 받지 않는다(PrivacyInformation). 대신 BytePlus 에
// 등록된 에셋(공개 디지털 캐릭터 · 비공개 가상 인물 라이브러리 · 본인 인증한 실존 인물)을 `asset://<에셋 ID>` 로 레퍼런스 자리에 넣는다
// (docs: seedance-portrait-asset-guide · upload-real-person-portrait-assets · private-virtual-avatar-library-guide, 2026-11-19~20).
//   { "type": "image_url", "image_url": { "url": "asset://asset-20260410114236-8cdfz" }, "role": "reference_image" }
// 지킬 것:
//   · 에셋은 내려받을 수 없다 — 화면은 썸네일 대신 표시만, 캐시 · R2 · 재업로드를 거치지 않는다(주소 그대로 보낸다).
//   · 에셋은 BytePlus **프로젝트마다** 따로다 — 그 에셋을 등록한 프로젝트의 키(= 그 팀의 프로젝트 코드)로만 쓸 수 있다.
//   · 프롬프트에서는 "Image 1 · Video 1 · Audio 1"(요청 안 같은 종류 순서)로 부른다 — 에셋 ID 를 프롬프트에 쓰지 말 것. 앱의 [Image N] 이 그 순서다.
//   · 옴니(구글)로는 못 간다.
// 서버 · 화면이 같이 쓴다 — UI · 스토어를 들이지 말 것(server 번들).

/** asset:// 뒤에 오는 것 — 문서의 id 는 asset-20260410114236-8cdfz 꼴. 옛 꼴(asset://character/00001)도 지나가게 넉넉히. */
const ASSET_URI = /^asset:\/\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/;

export const isAssetUri = (u: unknown): u is string => typeof u === 'string' && ASSET_URI.test(u);

/**
 * 받은 값 → asset://… 또는 null. 받는 꼴(문서에 있는 두 가지): `asset://<id>` · `asset-…`(BytePlus 에셋 ID — 앞에 asset:// 를 붙인다).
 * 앞뒤 공백만 뗀다. 따옴표가 붙었거나 빈칸이 든 글 · http 주소 등은 null — 고쳐 받지 않는다(§7-55). http(s) 는 부르는 쪽이 따로 본다.
 */
export function normalizeAssetRef(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim();
  if (!s) return null;
  if (/^asset:\/\//i.test(s)) s = 'asset://' + s.slice('asset://'.length);
  else if (/^asset-[A-Za-z0-9]/i.test(s)) s = 'asset://' + s;
  else return null;
  return isAssetUri(s) ? s : null;
}

/** 화면에 보일 짧은 이름 — asset://asset-20260410114236-8cdfz → asset-20260410114236-8cdfz */
export const assetLabel = (u: string): string => (isAssetUri(u) ? u.slice('asset://'.length) : u);

/** <img src> 로 쓸 수 있는 주소인가 — asset:// 는 브라우저가 못 연다(깨진 그림). 비었거나 에셋이면 false. */
export const imgSrcOk = (u: unknown): u is string => typeof u === 'string' && u.length > 0 && !isAssetUri(u);
