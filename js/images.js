// 야디지북 그림 다루기(브라우저 전용). 앱 저장소 docs/spec-yardage-book.md 4장.
// 넣을 때 긴 변이 1600px 보다 크면 1600px 로 줄이고, 작으면 원본 크기 그대로 둔다(키우지 않음, 2026-10-18 결정).
// 저장은 JPEG(품질 0.8). 원본이 1600px 이하 JPEG 면 다시 압축하지 않고 원본 파일 그대로 쓴다.

import { IMAGE_QUALITY, fitImageSize } from './model.js';

/** 그림 파일(Blob)을 JPEG 바이트로. */
export async function prepareImage(file) {
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height, resized } = fitImageSize(bitmap.width, bitmap.height);
    if (!resized && file.type === 'image/jpeg') return new Uint8Array(await file.arrayBuffer());
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    // PNG 의 투명한 곳은 흰 바탕으로(JPEG 는 투명을 못 담는다)
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('그림을 JPEG 로 바꾸지 못했어요'))), 'image/jpeg', IMAGE_QUALITY));
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close?.();
  }
}

const urls = new WeakMap();

/** 그림 바이트를 화면에 보여 줄 주소. 같은 바이트는 같은 주소를 다시 쓴다. */
export function imageUrl(bytes) {
  let url = urls.get(bytes);
  if (!url) {
    url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
    urls.set(bytes, url);
  }
  return url;
}
