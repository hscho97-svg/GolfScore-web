// 계산 규칙이 앱과 같은지. 같은 입력에 대한 앱 단위 테스트(ShotRulesTest, GolfClubTest, CourseTest)의 기대값을 옮겼다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as m from '../js/model.js';

const hole = (extra = {}) => ({
  number: 1, par: 4, strokes: 0, putts: 0, fairwayHit: null, greenInRegulation: false, penalties: 0,
  puttsEstimated: false, girEstimated: false, strokeIndex: null, shots: [], greenPosition: null,
  strokesEdited: false, extraStrokes: 0, ...extra,
});
const shot = (id) => ({ id, timeMillis: 0, position: null, clubId: null, penalty: false });

test('파 입력: 모자라거나 범위 밖은 기본 배치로 채운다', () => {
  assert.deepEqual(m.parsePars('4,4,3', 9), [4, 4, 3, 5, 4, 4, 3, 4, 5]);
  assert.deepEqual(m.parsePars('9 2 5', 3), [4, 4, 5]);
  assert.deepEqual(m.parsePars('3 4 5 5', 2), [3, 4]);
});

test('HCDP 입력: 홀 수만큼, 1~18, 겹치지 않음', () => {
  assert.deepEqual(m.parseStrokeIndexes('  ', 9), { kind: 'blank' });
  assert.deepEqual(m.parseStrokeIndexes('7,1.3 5 9 11 13 15 17', 9), { kind: 'valid', indexes: [7, 1, 3, 5, 9, 11, 13, 15, 17] });
  assert.equal(m.parseStrokeIndexes('1 2 3', 9).kind, 'invalid');
  assert.equal(m.parseStrokeIndexes('1 1 3 5 9 11 13 15 17', 9).kind, 'invalid');
  assert.equal(m.parseStrokeIndexes('19 1 3 5 9 11 13 15 17', 9).kind, 'invalid');
});

test('파: 3~6, 파3 이면 페어웨이를 비우고 GIR 을 다시 추정', () => {
  const h = m.setPar(hole({ strokes: 4, putts: 2, fairwayHit: true }), 3);
  assert.equal(h.par, 3);
  assert.equal(h.fairwayHit, null);
  assert.equal(h.greenInRegulation, false); // 4-2=2 > 1
  assert.equal(m.setPar(hole(), 9).par, 6);
  assert.equal(m.setPar(hole(), 1).par, 3);
});

test('GIR 추정: 타수 − 퍼팅 ≤ 파 − 2, 추정 표시는 퍼팅 추정을 따름', () => {
  const h = m.withEstimatedGir(hole({ strokes: 4, putts: 2, puttsEstimated: true }));
  assert.equal(h.greenInRegulation, true);
  assert.equal(h.girEstimated, true);
  // 퍼팅을 안 적었으면 판단하지 않는다
  assert.deepEqual(m.withEstimatedGir(hole({ strokes: 4 })), hole({ strokes: 4 }));
});

test('타수: 샷이 없는 홀은 그대로, 샷이 있는 홀은 고정(폰 칩과 같음)', () => {
  const plain = m.setStrokes(hole({ putts: 3 }), 2);
  assert.equal(plain.strokes, 2);
  assert.equal(plain.putts, 2); // 퍼팅은 타수를 넘지 않게
  assert.equal(plain.strokesEdited, false);

  const withShots = m.setStrokes(hole({ shots: [shot('a')], strokes: 1 }), 5);
  assert.equal(withShots.strokes, 5);
  assert.equal(withShots.strokesEdited, true);
});

test('타수 0: 치지 않은 홀로 되돌리되 샷과 HCDP 는 남기고, 샷이 있으면 고정', () => {
  const h = m.setStrokes(hole({ strokes: 5, putts: 2, penalties: 1, fairwayHit: true, strokeIndex: 7, shots: [shot('a')] }), 0);
  assert.equal(h.strokes, 0);
  assert.equal(h.putts, 0);
  assert.equal(h.penalties, 0);
  assert.equal(h.fairwayHit, null);
  assert.equal(h.strokeIndex, 7);
  assert.equal(h.shots.length, 1);
  assert.equal(h.strokesEdited, true);
});

test('퍼팅: 샷으로 타수를 채우는 홀은 타수가 따라오고, 아니면 타수를 넘지 않음', () => {
  const suggesting = hole({ shots: [shot('a')], strokes: 1 });
  assert.equal(m.setPutts(suggesting, 3).putts, 3);
  assert.equal(m.setPutts(suggesting, 3).strokes, 4);
  assert.equal(m.setPutts(hole({ strokes: 4 }), 6).putts, 4);
  assert.equal(m.setPutts(hole({ strokes: 4, putts: 2, puttsEstimated: true }), 2).puttsEstimated, false);
});

test('벌타: 0~9, 샷 기록이 있으면 타수를 다시 제안', () => {
  const h = hole({ shots: [shot('a')], strokes: 1 });
  assert.equal(m.setPenalties(h, 1).strokes, 2);
  assert.equal(m.setPenalties(h, -1).penalties, 0);
  assert.equal(m.setPenalties(h, 12).penalties, 9);
});

test('GIR·페어웨이 직접 바꾸기', () => {
  assert.deepEqual(m.setGir(hole({ girEstimated: true }), true), hole({ greenInRegulation: true, girEstimated: false }));
  assert.equal(m.setFairway(hole({ par: 3 }), true).fairwayHit, null);
  assert.equal(m.setFairway(hole(), true).fairwayHit, true);
});

const out = { id: 'out', name: 'OUT', pars: [4, 4, 3, 5, 4, 4, 3, 4, 5], strokeIndexes: [7, 1, 3, 5, 9, 11, 13, 15, 17] };
const inn = { id: 'in', name: 'IN', pars: [4, 3, 4, 5, 4, 4, 3, 4, 5], strokeIndexes: [8, 2, 4, 6, 10, 12, 14, 16, 18] };
const creek = { id: 'creek', name: '크리크', pars: Array(9).fill(4), strokeIndexes: null };
const club = { id: 'club', name: '베어크리크', nines: [out, inn], updatedAt: 0 };

test('조합: 코스 1개는 같은 코스 두 번, 2개는 순서 두 가지, 3개는 여섯 가지 + 9홀', () => {
  assert.deepEqual(m.combinations({ ...club, nines: [out] }).map(m.comboLabel), ['OUT → OUT']);
  assert.deepEqual(m.startOptions(club).map(m.comboLabel), ['OUT → IN', 'IN → OUT', 'OUT', 'IN']);
  assert.equal(m.combinations({ ...club, nines: [out, inn, creek] }).length, 6);
  assert.equal(m.roundName(club, { front: inn, back: out }), '베어크리크 (IN·OUT)');
});

test('조합 HCDP: 이어 붙이고, 모르거나 겹치면 비움', () => {
  assert.deepEqual(m.comboStrokeIndexes({ front: inn, back: out }), [...inn.strokeIndexes, ...out.strokeIndexes]);
  assert.deepEqual(m.comboStrokeIndexes({ front: out, back: null }), out.strokeIndexes);
  assert.equal(m.comboStrokeIndexes({ front: out, back: creek }), null);
  assert.equal(m.comboStrokeIndexes({ front: out, back: { ...creek, strokeIndexes: out.strokeIndexes } }), null);
});

const round18 = (pars) => ({
  id: 'r', courseName: '베어크리크', date: 0, note: '', inProgress: false, updatedAt: 0,
  courseId: null, courseRating: null, slopeRating: null, frontNineId: null, backNineId: null,
  holes: pars.map((p, i) => hole({ number: i + 1, par: p })),
});

test('코스 지정: 파가 달라도 지정, 원하면 코스의 파로 바꿈, 이름은 그대로', () => {
  const r = round18(m.DEFAULT_PARS_18);
  const combo = { front: inn, back: out };
  assert.ok(m.parMismatches(r, combo) > 0);

  const kept = m.withNines(r, club, combo);
  assert.equal(kept.courseId, 'club');
  assert.equal(kept.frontNineId, 'in');
  assert.equal(kept.backNineId, 'out');
  assert.deepEqual(kept.holes.map((h) => h.par), m.DEFAULT_PARS_18);
  assert.equal(kept.courseName, '베어크리크');

  const replaced = m.withNines(r, club, combo, true);
  assert.deepEqual(replaced.holes.map((h) => h.par), m.comboPars(combo));
  assert.equal(m.parMismatches(replaced, combo), 0);

  assert.throws(() => m.withNines(round18(m.defaultPars(9)), club, combo));
  const cleared = m.withoutNines(kept);
  assert.equal(cleared.frontNineId, null);
  assert.equal(cleared.courseId, 'club');
});

test('라운드 조합 찾기와 9홀 코스를 쓰는 라운드 수', () => {
  const r = m.withNines(round18(m.comboPars({ front: out, back: inn })), club, { front: out, back: inn });
  assert.equal(m.comboLabel(m.roundCombo(r, [club]).combo), 'OUT → IN');
  assert.equal(m.roundCombo(r, []), null);
  assert.equal(m.roundsUsingNine([r], 'club', 'in'), 1);
  assert.equal(m.roundsUsingNine([r], 'club', 'creek'), 0);
});

test('검사: 이름·파 9개·HCDP', () => {
  assert.deepEqual(m.clubProblems(club), []);
  const bad = { ...club, name: ' ', nines: [{ ...out, name: '', pars: [4, 4], strokeIndexes: [1, 1, 2, 3, 4, 5, 6, 7, 8] }] };
  const problems = m.clubProblems(bad);
  assert.equal(problems.length, 4);
  assert.ok(problems[1].startsWith('1st 코스'));
});

test('코스 순서 이름', () => {
  assert.deepEqual([0, 1, 2, 3, 10, 11, 20].map(m.ordinalCourse), ['1st 코스', '2nd 코스', '3rd 코스', '4th 코스', '11th 코스', '12th 코스', '21st 코스']);
});

test('날짜만 바꾸고 시각은 그대로', () => {
  const t = new Date(2026, 8, 1, 7, 30).getTime();
  const moved = new Date(m.withPickedDate(t, '2026-10-23'));
  assert.equal(m.isoDay(moved.getTime()), '2026-10-23');
  assert.equal(moved.getHours(), 7);
  assert.equal(moved.getMinutes(), 30);
});

test('레이팅·슬로프 읽기', () => {
  assert.equal(m.parseRating('71,8'), 71.8);
  assert.equal(m.parseRating('95'), null);
  assert.equal(m.parseRating(''), null);
  assert.equal(m.parseSlope('128'), 128);
  assert.equal(m.parseSlope('40'), null);
  assert.equal(m.parseSlope('12.5'), null);
});

test('9홀 코스 레이팅·슬로프: 범위 검사와 18홀 계산(WHS: 합·평균)', () => {
  assert.equal(m.parseNineRating('35,6'), 35.6);
  assert.equal(m.parseNineRating('71.2'), null); // 18홀 값을 잘못 넣음
  assert.equal(m.parseNineRating(''), null);

  const a = { ...out, courseRating: 35.6, slopeRating: 127 };
  const b = { ...inn, courseRating: 36.1, slopeRating: 130 };
  assert.deepEqual(m.comboRatings({ front: a, back: b }), { courseRating: 71.7, slopeRating: 129 }); // (127+130)/2 = 128.5 → 129
  assert.deepEqual(m.comboRatings({ front: a, back: null }), { courseRating: 35.6, slopeRating: 127 });
  assert.deepEqual(m.comboRatings({ front: a, back: inn }), { courseRating: null, slopeRating: null });

  assert.deepEqual(m.nineProblems({ ...a, courseRating: 71.7 }), ['코스 레이팅은 15~45 이어야 해요(9홀 값)']);
  assert.deepEqual(m.nineProblems({ ...a, slopeRating: 40 }), ['슬로프는 55~155 정수여야 해요']);
});

test('코스 지정 때 라운드 레이팅이 비어 있으면 조합 값으로 채우고, 있으면 그대로', () => {
  const combo = { front: { ...out, courseRating: 35.6, slopeRating: 127 }, back: { ...inn, courseRating: 36.1, slopeRating: 130 } };
  const empty = round18(m.comboPars(combo));
  assert.deepEqual([m.withComboRatingsIfEmpty(empty, combo).courseRating, m.withComboRatingsIfEmpty(empty, combo).slopeRating], [71.7, 129]);
  const filled = { ...empty, courseRating: 70.1, slopeRating: null };
  const r = m.withComboRatingsIfEmpty(filled, combo);
  assert.equal(r.courseRating, 70.1);
  assert.equal(r.slopeRating, 129);
});
