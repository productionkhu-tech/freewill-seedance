// 파일 → 어셋 라이브러리 사진(ElementImage). 화면(ElementLibrary) · 에이전트 elements.add · 레퍼런스 칸 방패 · 막혔을 때 자동 인증(send-request)이
// 같이 쓴다(26.11.24~ ElementLibrary.tsx 에서 옮김 — 화면 파일을 들이지 않고 lib 에서 부를 수 있게). 하는 일은 그대로다.
//
// Process a picked/dropped file into an ElementImage: small thumbnail (for prompt pills
// and the editor grid) + the ORIGINAL bytes stored as a file in the server library
// (libId). 26.9.3001~ the original is never held in memory as base64 — cards and hover
// load a JPG preview by URL (libraryPreviewSrc), and send/copy/share read the original
// file untouched. storeLibraryImage verifies the server wrote every byte.
// path: 파일 객체에서 경로를 못 얻는 길(에이전트는 경로로 읽어 File 을 새로 만든다)이 알려 주는 원본 경로.
import type { ElementImage } from '../store';
import { getFilePath, validateImageFile, validateImageDimensions, createThumbnail, storeLibraryImage } from './utils';

export async function fileToElementImage(file: File, path?: string): Promise<ElementImage> {
  const sizeErr = validateImageFile(file);
  if (sizeErr) throw new Error(sizeErr);
  const dimErr = await validateImageDimensions(file);
  if (dimErr) throw new Error(dimErr);
  // 256, not the 80 default: the thumbnail is what the editor grid and the drop dialog
  // actually paint, and 80px was sized for prompt pills. ~15KB per image — noise.
  const [thumbnailUrl, libId] = await Promise.all([createThumbnail(file, 256), storeLibraryImage(file, file.name)]);
  const originalPath = path || getFilePath(file);
  return { id: crypto.randomUUID(), libId, thumbnailUrl, ...(file.name ? { file_name: file.name } : {}), ...(originalPath ? { originalPath } : {}) };
}
