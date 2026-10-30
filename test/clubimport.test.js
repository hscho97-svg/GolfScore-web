// AI 결과 붙여넣기(golfscore-club/1). 앱 저장소 docs/spec-club-import.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ImportError, buildClub, checkFormat, extractJson, findClub, imageListText } from '../js/clubimport.js';
import { PROMPT } from '../js/prompt.js';

const sampleText = readFileSync(new URL('../examples/sample-club.json', import.meta.url), 'utf8');
const sample = () => JSON.parse(sampleText);

test('AI 답의 설명 문장·코드 블록 표시를 버리고 JSON 만 꺼낸다', () => {
  const answer = `정리했어요.\n\`\`\`json\n${sampleText}\n\`\`\`\n확인해 보세요 {끝}`;
  assert.equal(extractJson(answer).club.name, '가상밸리CC');
});

test('글 안의 중괄호·따옴표는 짝 맞추기에 세지 않는다', () => {
  const json = extractJson('앞 {"a": "x } \\" {", "b": {"c": 1}} 뒤 }');
  assert.deepEqual(json, { a: 'x } " {', b: { c: 1 } });
});

test('JSON 이 없거나 끊기면 이유를 알려 준다', () => {
  assert.throws(() => extractJson('없음'), ImportError);
  assert.throws(() => extractJson('{"a": 1'), /끊겼/);
  assert.throws(() => extractJson('{a: 1}'), /읽지 못했/);
});

test('형식 검사: format, 홀 9개, number 1~9 한 번씩', () => {
  assert.throws(() => checkFormat({ format: 'x', club: {} }), /format/);
  const short = sample();
  short.club.nines[1].holes.pop();
  assert.throws(() => checkFormat(short), /레이크: 홀이 9개/);
  const dup = sample();
  dup.club.nines[0].holes[1].number = 1;
  assert.throws(() => checkFormat(dup), /힐: 홀이 9개/);
  const sameNames = sample();
  sameNames.club.nines[1].name = ' 힐 ';
  assert.throws(() => checkFormat(sameNames), /겹쳐요/);
});

test('홀 순서가 섞여 있으면 number 로 맞춘다', () => {
  const json = sample();
  json.club.nines[0].holes.reverse();
  const { club } = buildClub(checkFormat(json));
  assert.deepEqual(club.nines[0].pars, [4, 5, 3, 4, 4, 3, 4, 5, 4]);
});

test('새 골프장: 야드는 미터로, 자리표시 글은 비우고, 참고 정보·그림 목록을 만든다', () => {
  const r = buildClub(checkFormat(sample()));
  const [hill, lake] = r.club.nines;
  assert.equal(r.club.name, '가상밸리CC');
  assert.deepEqual(r.club.tees, ['블루', '화이트', '레드']);
  assert.equal(hill.holes[0].distances['블루'], 366); // 400yd
  assert.equal(hill.holes[2].description, null); // "코스 업데이트 예정"
  assert.deepEqual(hill.strokeIndexes, [7, 3, 15, 1, 11, 17, 5, 9, 13]);
  assert.equal(hill.courseRating, 35.4);
  assert.equal(lake.courseRating, null);
  assert.deepEqual(lake.holes[0].hazards, ['왼쪽 연못']);
  assert.notEqual(hill.id, lake.id);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.changes, { removed: [], changed: [] });
  assert.ok(r.reference.some((x) => x.includes('힐+레이크 화이트: 70.8')));
  assert.deepEqual(r.images.map((x) => x.fileName), ['힐_1_hole.png', '힐_1_green.jpg']);
  assert.match(imageListText(r.images), /^힐 1번 홀 지도 → 힐_1_hole.png : https:/);
  assert.deepEqual(r.notes, ['가짜 골프장(시험용). 레이크 코스는 화이트 거리만 있음']);
});

test('경고: 단위 없음, 티 목록에 없는 거리, HCDP 일부만, 파 합계, 홀수·짝수', () => {
  const json = sample();
  json.club.distanceUnit = null;
  json.club.nines[0].holes[0].distances['골드'] = 410;
  json.club.nines[1].holes[0].hcdp = null;
  json.club.nines[1].holes[1].par = 6;
  json.club.nines[1].holes[2].par = 6;
  json.club.nines[1].holes[3].par = 6;
  const r = buildClub(checkFormat(json));
  assert.equal(r.club.nines[0].holes[0].distances['블루'], 400);
  assert.equal(r.club.nines[0].holes[0].distances['골드'], undefined);
  assert.equal(r.club.nines[1].strokeIndexes, null);
  const all = r.warnings.join('\n');
  assert.match(all, /미터로 봤어요/);
  assert.match(all, /"골드" 티/);
  assert.match(all, /레이크: HCDP 가 8개만/);
  assert.match(all, /레이크: 파 합계가 42/);

  const parity = sample();
  parity.club.nines[1].holes[0].hcdp = 1; // 힐에도 1 이 있지만 코스 안에서는 겹치지 않음
  parity.club.nines[1].holes[1].hcdp = 8;
  assert.match(buildClub(checkFormat(parity)).warnings.join(), /홀수/);
});

test('숫자 글자("4")도 받고, 파가 없으면 null 로 둔다(편집 화면에서 빨간 칸)', () => {
  const json = sample();
  json.club.nines[0].holes[0].par = '4';
  json.club.nines[0].holes[1].par = null;
  const { club } = buildClub(checkFormat(json));
  assert.equal(club.nines[0].pars[0], 4);
  assert.equal(club.nines[0].pars[1], null);
});

test('같은 골프장 찾기: 공백·대소문자 무시', () => {
  const clubs = [{ id: 'a', name: '가상밸리 cc' }, { id: 'b', name: '다른곳' }];
  assert.equal(findClub(clubs, '가상밸리CC').id, 'a');
  assert.equal(findClub(clubs, '없는곳'), null);
  assert.equal(findClub(clubs, ''), null);
});

/** 웹 도구에서 손으로 만든 기존 골프장(힐 + 계곡). */
function existingClub() {
  return {
    id: 'club-1', name: '가상밸리 컨트리클럽', updatedAt: 111, memo: '모르는 필드',
    tees: ['레귤러', '레드'],
    nines: [
      {
        id: 'nine-hill', name: 'HILL', pars: [4, 5, 3, 4, 4, 3, 4, 4, 4], strokeIndexes: null, courseRating: 36.0, slopeRating: 130, extra: 1,
        holes: [...Array(9)].map((_, k) => ({
          number: k + 1, distances: { 레귤러: 300 + k, 레드: 250 }, description: k === 1 ? '손으로 적은 공략' : null, hazards: [],
          greenNote: null, myNote: k === 0 ? '드라이버 대신 3W' : null, holeImage: k === 0 ? 'nine-hill_1_hole.jpg' : null, greenImage: null,
        })),
      },
      { id: 'nine-valley', name: '계곡', pars: [4, 4, 4, 4, 4, 4, 4, 4, 4], strokeIndexes: null, courseRating: null, slopeRating: null },
    ],
  };
}

test('기존 골프장: 이름이 같은 9홀 코스를 통째로 바꾸고, id·이름·내 메모·그림·없는 코스는 그대로', () => {
  const json = sample();
  json.club.name = '가상밸리CC';
  json.club.nines[0].name = 'hill';
  const r = buildClub(checkFormat(json), existingClub());
  const c = r.club;
  assert.equal(c.id, 'club-1');
  assert.equal(c.name, '가상밸리 컨트리클럽');
  assert.equal(c.updatedAt, 111);
  assert.equal(c.memo, '모르는 필드');
  assert.deepEqual(c.tees, ['블루', '화이트', '레드']);
  assert.deepEqual(c.nines.map((n) => n.id).slice(0, 1), ['nine-hill']);
  assert.deepEqual(c.nines.map((n) => n.name), ['HILL', '레이크', '계곡']);
  assert.equal(c.nines[2].id, 'nine-valley');
  const hill = c.nines[0];
  assert.equal(hill.extra, 1);
  assert.equal(hill.pars[1], 5);
  assert.deepEqual(hill.strokeIndexes, [7, 3, 15, 1, 11, 17, 5, 9, 13]);
  assert.equal(hill.courseRating, 35.4);
  assert.equal(hill.holes[0].myNote, '드라이버 대신 3W');
  assert.equal(hill.holes[0].holeImage, 'nine-hill_1_hole.jpg');
  assert.equal(hill.holes[1].description, null); // JSON 이 null 이라 통째로 바뀜
  assert.equal(hill.holes[0].distances['레귤러'], undefined);
  assert.equal(r.images[0].fileName, 'HILL_1_hole.png'); // 그림 이름은 남는 코스 이름으로

  const { removed, changed } = r.changes;
  assert.ok(removed.includes('티 빠짐(그 티의 거리도 지워짐): 레귤러'));
  assert.ok(removed.includes('HILL 공략: 2번'));
  assert.ok(changed.includes('티 추가: 블루, 화이트'));
  assert.ok(changed.includes('새 9홀 코스: 레이크'));
  assert.ok(changed.includes('HILL 코스 레이팅 36→35.4'));
  assert.ok(changed.includes('HILL HCDP'));
  assert.ok(changed.includes('HILL 공략 1홀 채움'));
  assert.ok(changed.some((x) => x.startsWith('HILL 티별 거리')));
});

test('기존 코스의 값이 JSON 에서 null 이면 지움으로 보여 준다', () => {
  const before = existingClub();
  before.nines[0].strokeIndexes = [7, 3, 15, 1, 11, 17, 5, 9, 13];
  const json = sample();
  json.club.nines = [json.club.nines[0]];
  json.club.nines[0].name = 'HILL';
  json.club.nines[0].courseRating = null;
  json.club.nines[0].holes[4].hcdp = null;
  const r = buildClub(checkFormat(json), before);
  assert.equal(r.club.nines[0].courseRating, null);
  assert.equal(r.club.nines[0].strokeIndexes, null);
  assert.ok(r.changes.removed.includes('HILL 코스 레이팅'));
  assert.ok(r.changes.removed.includes('HILL HCDP'));
});

test('야디지북이 없던 코스에 JSON 도 글·거리가 없으면 holes 를 만들지 않는다', () => {
  const before = existingClub();
  const json = sample();
  json.club.tees = [];
  json.club.nines = [json.club.nines[1]];
  json.club.nines[0].name = '계곡';
  json.club.nines[0].holes.forEach((x) => {
    x.distances = {};
    x.description = null;
    x.hazards = [];
  });
  const r = buildClub(checkFormat(json), before);
  const valley = r.club.nines.find((n) => n.id === 'nine-valley');
  assert.equal('holes' in valley, false);
  assert.deepEqual(valley.pars, [4, 4, 3, 5, 4, 4, 3, 4, 5]);
});

test('프롬프트에 형식 이름과 더한 규칙이 들어 있다', () => {
  assert.match(PROMPT, /golfscore-club\/1/);
  assert.match(PROMPT, /업데이트 예정/);
  assert.match(PROMPT, /파와 맞지 않/);
});
