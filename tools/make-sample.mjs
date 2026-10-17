// 예시 백업 파일을 만든다. 모두 가짜 골프장·라운드다(개인 데이터를 저장소에 넣지 않는다).
//   examples/sample-backup.json        폰이 내보낸 것과 같은 모양(앱 v2, 모든 필드 포함)
//   examples/sample-backup-edited.json 웹 도구 규칙으로 고친 결과(앱 shared 테스트가 읽어 확인)
// 실행: node tools/make-sample.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { buildSave, openBackup } from '../js/backup.js';
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
    { id: 'nine-a', name: '가람', pars: [4, 4, 3, 5, 4, 4, 3, 4, 5], strokeIndexes: [7, 1, 17, 5, 11, 3, 15, 13, 9] },
    { id: 'nine-b', name: '누리', pars: [4, 3, 4, 5, 4, 4, 3, 4, 5], strokeIndexes: [8, 18, 2, 6, 10, 4, 16, 14, 12] },
    { id: 'nine-c', name: '다온', pars: [5, 4, 3, 4, 4, 3, 5, 4, 4], strokeIndexes: null },
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
let edited = m.withNines(b.rounds.find((r) => r.id === 'round-old'), sampleClub, combo, true);
edited = m.updateHole(edited, 2, (h) => m.setPutts(m.setStrokes(h, 4), 1));
edited = m.setRoundStrokeIndexes(edited, m.comboStrokeIndexes(combo));
b.rounds = b.rounds.map((r) => (r.id === edited.id ? edited : r));
b.clubs = [{ ...sampleClub, nines: [...sampleClub.nines, { id: 'nine-d', name: '라온', pars: [4, 4, 4, 3, 5, 4, 4, 3, 5], strokeIndexes: null }] }];
const saved = buildSave(state, T0 + 4 * 86400000);
writeFileSync('examples/sample-backup-edited.json', saved.text);
console.log('examples/sample-backup.json, examples/sample-backup-edited.json');
