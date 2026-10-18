// 예시 백업 파일을 만든다. 모두 가짜 골프장·라운드다(개인 데이터를 저장소에 넣지 않는다).
//   examples/sample-backup.json        폰이 내보낸 것과 같은 모양(앱 v2, 모든 필드 포함)
//   examples/sample-backup-edited.json 웹 도구 규칙으로 고친 결과(앱 shared 테스트가 읽어 확인)
//   examples/sample-backup-yardage.zip 야디지북(v3)·가짜 그림·지운 라운드(앱 shared 테스트가 읽어 확인)
// 실행: node tools/make-sample.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { buildSave, buildZip, deleteItem, openBackup } from '../js/backup.js';
import { crc32 } from '../js/zip.js';
import * as m from '../js/model.js';

const T0 = Date.UTC(2026, 8, 1, 3, 0, 0); // 2026-09-01 12:00 KST

const hole = (number, par, strokes = 0, putts = 0, extra = {}) => ({
  number,
  par,
  strokes,
  putts,
  fairwayHit: null,
  greenInRegulation: false,
  penalties: 0,
  puttsEstimated: false,
  girEstimated: false,
  strokeIndex: null,
  shots: [],
  greenPosition: null,
  strokesEdited: false,
  extraStrokes: 0,
  ...extra,
});

const fix = (lat, lon, t) => ({ lat, lon, accuracyM: 4.0, timeMillis: t });
const position = (lat, lon, t) => ({
  lat,
  lon,
  accuracyM: 3.5,
  samples: 3,
  timeMillis: t,
  fixes: [fix(lat, lon, t - 2000), fix(lat, lon, t - 1000), fix(lat, lon, t)],
});

const club = {
  id: 'club-sample',
  name: '샘플CC',
  nines: [
    { id: 'nine-a', name: '가람', pars: [4, 4, 3, 5, 4, 4, 3, 4, 5], strokeIndexes: [7, 1, 17, 5, 11, 3, 15, 13, 9], courseRating: 35.6, slopeRating: 127 },
    { id: 'nine-b', name: '누리', pars: [4, 3, 4, 5, 4, 4, 3, 4, 5], strokeIndexes: [8, 18, 2, 6, 10, 4, 16, 14, 12], courseRating: 36.1, slopeRating: 130 },
    { id: 'nine-c', name: '다온', pars: [5, 4, 3, 4, 4, 3, 5, 4, 4], strokeIndexes: null, courseRating: null, slopeRating: null },
  ],
  updatedAt: T0,
};

const pars18 = [...club.nines[0].pars, ...club.nines[1].pars];
const si18 = [...club.nines[0].strokeIndexes, ...club.nines[1].strokeIndexes];

// 1) 골프장 조합(가람→누리)으로 친 18홀, 1번 홀에 샷 기록
const played = {
  id: 'round-played',
  courseName: '샘플CC (가람·누리)',
  date: T0 + 86400000,
  holes: pars18.map((p, i) => hole(i + 1, p, p + 1, 2, { strokeIndex: si18[i], greenInRegulation: false, puttsEstimated: false })),
  note: '예시 라운드',
  inProgress: false,
  updatedAt: T0 + 86400000,
  courseId: 'club-sample',
  courseRating: 71.2,
  slopeRating: 128,
  frontNineId: 'nine-a',
  backNineId: 'nine-b',
};
played.holes[0] = {
  ...played.holes[0],
  strokes: 5,
  putts: 2,
  shots: [
    { id: 'shot-1', timeMillis: T0 + 86400000, position: position(37.5, 127.0, T0 + 86400000), clubId: 'DR', penalty: false },
    { id: 'shot-2', timeMillis: T0 + 86500000, position: position(37.502, 127.0, T0 + 86500000), clubId: '7I', penalty: false },
    { id: 'shot-3', timeMillis: T0 + 86600000, position: null, clubId: null, penalty: false },
  ],
  greenPosition: position(37.503, 127.0, T0 + 86650000),
};

// 2) 코스를 지정하지 않은 옛 라운드(웹에서 지정해 볼 대상)
const old = {
  id: 'round-old',
  courseName: '샘플 옛 기록',
  date: T0 - 30 * 86400000,
  holes: m.defaultPars(18).map((p, i) => hole(i + 1, p, p + 2, 2, { puttsEstimated: true, girEstimated: true })),
  note: '',
  inProgress: false,
  updatedAt: T0 - 30 * 86400000,
  courseId: null,
  courseRating: null,
  slopeRating: null,
  frontNineId: null,
  backNineId: null,
};

// 3) 진행 중인 기본 9홀
const playing = {
  id: 'round-playing',
  courseName: '9월 3일 라운드',
  date: T0 + 2 * 86400000,
  holes: m.defaultPars(9).map((p, i) => hole(i + 1, p)),
  note: '',
  inProgress: true,
  updatedAt: T0 + 2 * 86400000,
  courseId: null,
  courseRating: null,
  slopeRating: null,
  frontNineId: null,
  backNineId: null,
};

const sample = {
  version: 2,
  exportedAt: T0 + 3 * 86400000,
  rounds: [playing, played, old],
  clubs: [club],
  courses: [],
  bag: {
    clubs: [
      { id: 'DR', name: '드라이버', active: true },
      { id: '7I', name: '7I', active: true },
    ],
    updatedAt: T0,
  },
};

mkdirSync('examples', { recursive: true });
const sampleText = JSON.stringify(sample);
writeFileSync('examples/sample-backup.json', sampleText);

// 웹 도구로 고친 결과: 옛 라운드를 누리→가람으로 지정(파 바꾸기), 2번 홀 타수·퍼팅 수정, 골프장에 4th 코스 추가
let state = openBackup(sampleText);
const b = state.backup;
const sampleClub = b.clubs[0];
const combo = { front: sampleClub.nines[1], back: sampleClub.nines[0] };
let edited = m.withComboRatingsIfEmpty(m.withNines(b.rounds.find((r) => r.id === 'round-old'), sampleClub, combo, true), combo);
edited = m.updateHole(edited, 2, (h) => m.setPutts(m.setStrokes(h, 4), 1));
edited = m.setRoundStrokeIndexes(edited, m.comboStrokeIndexes(combo));
b.rounds = b.rounds.map((r) => (r.id === edited.id ? edited : r));
b.clubs = [{ ...sampleClub, nines: [...sampleClub.nines, { id: 'nine-d', name: '라온', pars: [4, 4, 4, 3, 5, 4, 4, 3, 5], strokeIndexes: null, courseRating: 34.8, slopeRating: 121 }] }];
const saved = buildSave(state, T0 + 4 * 86400000);
writeFileSync('examples/sample-backup-edited.json', saved.text);

// 야디지북(백업 v3, zip): 가람 코스에 티별 거리·공략, 1번 홀에 홀·그린 지도(직접 그린 가짜 그림), 진행 중 라운드 지우기.
// 그림은 실제 골프장 것이 아니라 이 스크립트가 그린 도형이다(공개 저장소에 골프장 그림을 넣지 않는다).
state = saved.state;
const yb = state.backup;
const tees = ['블루', '화이트', '레드'];
const ga = yb.clubs[0].nines[0];
const distances = [[362, 340, 295], [395, 372, 320], [168, 150, 120], [520, 498, 430], [380, 356, 300], [410, 388, 330], [185, 162, 128], [350, 330, 280], [505, 480, 415]];
const holes = ga.pars.map((par, k) => ({
  number: k + 1,
  distances: Object.fromEntries(tees.map((t, j) => [t, distances[k][j]])),
  description: k === 0 ? '티샷은 페어웨이 오른쪽을 겨냥. 세컨드는 그린 왼쪽 앞을 노린다' : null,
  hazards: k === 0 ? ['왼쪽 OB', '그린 앞 벙커'] : [],
  greenNote: k === 0 ? '앞뒤로 긴 그린, 뒤에서 앞으로 내리막' : null,
  myNote: k === 0 ? '드라이버 대신 3W' : null,
  holeImage: k === 0 ? m.imageName(ga.id, 1, 'hole') : null,
  greenImage: k === 0 ? m.imageName(ga.id, 1, 'green') : null,
}));
yb.clubs = [{ ...yb.clubs[0], tees, nines: yb.clubs[0].nines.map((n, i) => (i === 0 ? { ...n, holes } : n)) }];
state.images.set(m.imageName(ga.id, 1, 'hole'), fakeHolePng(400, 640, false));
state.images.set(m.imageName(ga.id, 1, 'green'), fakeHolePng(480, 360, true));
state.changedImages = new Set(state.images.keys());
deleteItem(state, 'round', 'round-playing');
const yardage = buildSave(state, T0 + 5 * 86400000);
writeFileSync('examples/sample-backup-yardage.zip', buildZip(yardage.text, yardage.backup, state.images).bytes);
console.log('examples/sample-backup.json, examples/sample-backup-edited.json, examples/sample-backup-yardage.zip');

/** 가짜 홀 그림(PNG): 짙은 러프 바탕에 페어웨이·그린·티. green 이면 그린만 크게. 파일 이름은 .jpg 지만 앱·브라우저 모두 내용으로 읽는다. */
function fakeHolePng(width, height, green) {
  const px = new Uint8Array(width * height * 3);
  const set = (x, y, [r, g, b]) => {
    const i = (y * width + x) * 3;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let c = [46, 94, 52]; // 러프
      if (green) {
        const d = ((x - width / 2) / (width * 0.4)) ** 2 + ((y - height / 2) / (height * 0.38)) ** 2;
        if (d < 1) c = [112, 186, 104];
        if (Math.abs(x - width * 0.6) < 3 && Math.abs(y - height * 0.45) < 24) c = [240, 240, 240]; // 깃대
      } else {
        const fx = width / 2 + Math.sin((y / height) * Math.PI) * width * 0.12;
        if (Math.abs(x - fx) < width * 0.13 && y > height * 0.18 && y < height * 0.9) c = [92, 160, 84]; // 페어웨이
        if ((x - width * 0.5) ** 2 + (y - height * 0.12) ** 2 < (width * 0.12) ** 2) c = [120, 196, 110]; // 그린
        if ((x - width * 0.62) ** 2 + (y - height * 0.2) ** 2 < (width * 0.05) ** 2) c = [222, 205, 150]; // 벙커
        if (Math.abs(x - width / 2) < 14 && Math.abs(y - height * 0.94) < 8) c = [180, 220, 170]; // 티
      }
      set(x, y, c);
    }
  }
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(px.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  const png = new Uint8Array(parts.reduce((s, x) => s + x.length, 0));
  let p = 0;
  for (const part of parts) {
    png.set(part, p);
    p += part.length;
  }
  return png;
}
