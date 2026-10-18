// 백업 v3: zip(그림 묶기), 지운 항목 표시, 야디지북 입력 규칙. 앱 저장소 docs/spec-yardage-book.md
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { buildSave, buildZip, changeCount, changesOf, deleteItem, openBackup, openBackupBytes, saveFileName, undoDelete } from '../js/backup.js';
import { crc32, isZip, readZip, writeZip } from '../js/zip.js';
import * as m from '../js/model.js';

const sampleText = readFileSync(new URL('../examples/sample-backup.json', import.meta.url), 'utf8');
const enc = new TextEncoder();

test('crc32 는 알려진 값과 같다', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
});

test('zip 쓰고 읽기(묶기만), 이름은 UTF-8', async () => {
  const bytes = writeZip([
    { name: 'backup.json', bytes: enc.encode('{"a":1}') },
    { name: 'images/n_1_hole.jpg', bytes: new Uint8Array([1, 2, 3]) },
    { name: '한글.txt', bytes: enc.encode('가') },
  ]);
  assert.ok(isZip(bytes));
  const files = await readZip(bytes);
  assert.deepEqual([...files.keys()], ['backup.json', 'images/n_1_hole.jpg', '한글.txt']);
  assert.deepEqual([...files.get('images/n_1_hole.jpg')], [1, 2, 3]);
});

test('압축된(deflate) zip 도 읽는다', async () => {
  // 로컬 헤더·중앙 디렉터리를 손으로 만든 deflate 항목 하나
  const data = enc.encode('hello hello hello hello');
  const packed = deflateRawSync(data);
  const name = enc.encode('a.txt');
  const local = new Uint8Array(30 + name.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(8, 8, true);
  lv.setUint32(14, crc32(data), true);
  lv.setUint32(18, packed.length, true);
  lv.setUint32(22, data.length, true);
  lv.setUint16(26, name.length, true);
  local.set(name, 30);
  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, 8, true);
  cv.setUint32(16, crc32(data), true);
  cv.setUint32(20, packed.length, true);
  cv.setUint32(24, data.length, true);
  cv.setUint16(28, name.length, true);
  central.set(name, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length + packed.length, true);
  const zip = new Uint8Array([...local, ...packed, ...central, ...end]);
  const files = await readZip(zip);
  assert.equal(new TextDecoder().decode(files.get('a.txt')), 'hello hello hello hello');
});

test('v2 파일은 v3 로 열고, 저장하면 v3', () => {
  const state = openBackup(sampleText);
  assert.deepEqual(state.backup.deleted, []);
  assert.equal(JSON.parse(buildSave(state, 1).text).version, 3);
});

test('백업 zip 열기: backup.json 과 안전한 이름의 그림만', async () => {
  const zip = writeZip([
    { name: 'backup.json', bytes: enc.encode(sampleText) },
    { name: 'images/nine-a_1_hole.jpg', bytes: new Uint8Array([9]) },
    { name: 'images/../evil.jpg', bytes: new Uint8Array([1]) },
  ]);
  const state = await openBackupBytes(zip);
  assert.ok(state.fromZip);
  assert.deepEqual([...state.images.keys()], ['nine-a_1_hole.jpg']);
  assert.equal(state.backup.rounds.length, 3);

  const json = await openBackupBytes(enc.encode(sampleText));
  assert.equal(json.fromZip, false);
  await assert.rejects(openBackupBytes(writeZip([{ name: 'x.txt', bytes: enc.encode('x') }])), /backup.json/);
});

test('저장 zip 에는 골프장이 쓰는 그림만 넣고, 파일에 없는 그림 수를 알려 준다', async () => {
  const state = openBackup(sampleText);
  state.backup.clubs[0].nines[0].holes = [{ number: 1, holeImage: 'nine-a_1_hole.jpg', greenImage: 'nine-a_1_green.jpg' }];
  state.images.set('nine-a_1_hole.jpg', new Uint8Array([7]));
  state.images.set('unused_1_hole.jpg', new Uint8Array([8]));
  const { text, backup } = buildSave(state, 1);
  const zip = buildZip(text, backup, state.images);
  assert.equal(zip.images, 1);
  assert.equal(zip.missing, 1);
  const files = await readZip(zip.bytes);
  assert.deepEqual([...files.keys()], ['backup.json', 'images/nine-a_1_hole.jpg']);
  assert.equal(saveFileName(new Date(2026, 9, 18, 9).getTime(), 'zip'), 'golfscore-backup-20261018-web.zip');
});

test('지우기: 목록에서 빼고 deleted 에 남기며, 지운 시각은 저장할 때 정한다. 되돌리기 가능', () => {
  const state = openBackup(sampleText);
  deleteItem(state, 'round', 'round-old');
  assert.equal(state.backup.rounds.some((r) => r.id === 'round-old'), false);
  assert.equal(changesOf(state).deletions.length, 1);
  assert.equal(changeCount(changesOf(state)), 1);

  undoDelete(state, 'round', 'round-old');
  assert.equal(state.backup.rounds.some((r) => r.id === 'round-old'), true);
  assert.deepEqual(state.backup.deleted, []);
  assert.equal(changesOf(state).deletions.length, 0);

  deleteItem(state, 'club', 'club-sample');
  const { text, state: after } = buildSave(state, 1234);
  const saved = JSON.parse(text);
  assert.deepEqual(saved.deleted, [{ kind: 'club', id: 'club-sample', deletedAt: 1234 }]);
  assert.equal(saved.clubs.length, 0);
  // 저장 뒤에는 바뀐 것이 없다(지운 표시는 파일에 남음)
  assert.equal(changeCount(changesOf(after)), 0);
});

test('이번에 새로 만든 골프장을 지우면 표시 없이 뺀다', () => {
  const state = openBackup(sampleText);
  state.backup.clubs.push({ id: 'tmp', name: '임시', nines: [], updatedAt: 0 });
  deleteItem(state, 'club', 'tmp');
  assert.deepEqual(state.backup.deleted, []);
  assert.equal(changesOf(state).deletions.length, 0);
});

test('거리 칸: 미터, 야드로 적으면 미터로, 범위 밖은 NaN', () => {
  assert.equal(m.parseDistance(''), null);
  assert.equal(m.parseDistance('385'), 385);
  assert.equal(m.parseDistance('400', true), 366);
  assert.ok(Number.isNaN(m.parseDistance('0')));
  assert.ok(Number.isNaN(m.parseDistance('701')));
  assert.ok(Number.isNaN(m.parseDistance('3.5')));
  assert.equal(m.mToYd(366), 400);
});

test('그림 파일 이름 규칙 읽기', () => {
  assert.deepEqual(m.parseImageFileName('가람_1_hole.jpg'), { course: '가람', number: 1, kind: 'hole' });
  assert.deepEqual(m.parseImageFileName('OUT_9_GREEN.PNG'), { course: 'OUT', number: 9, kind: 'green' });
  assert.deepEqual(m.parseImageFileName('마운틴 코스_3_hole.jpeg'), { course: '마운틴 코스', number: 3, kind: 'hole' });
  assert.equal(m.parseImageFileName('가람_10_hole.jpg'), null);
  assert.equal(m.parseImageFileName('사진.jpg'), null);
});

test('그림 크기: 1600px 보다 크면 줄이고, 작으면 원본 그대로', () => {
  assert.deepEqual(m.fitImageSize(3200, 1800), { width: 1600, height: 900, resized: true });
  assert.deepEqual(m.fitImageSize(900, 1200), { width: 900, height: 1200, resized: false });
  assert.deepEqual(m.fitImageSize(1600, 1000), { width: 1600, height: 1000, resized: false });
});

test('그림 이름과 안전한 이름 검사, 쓰는 그림 모으기', () => {
  assert.equal(m.imageName('nine-a', 3, 'green'), 'nine-a_3_green.jpg');
  assert.ok(m.isSafeImageName('2f9c-ab_1_hole.jpg'));
  assert.ok(!m.isSafeImageName('../x.jpg'));
  assert.ok(!m.isSafeImageName('a/b.jpg'));
  const clubs = [{ nines: [{ holes: [{ number: 1, holeImage: 'a_1_hole.jpg' }, { number: 2, greenImage: 'a_2_green.jpg' }] }, { holes: null }] }];
  assert.deepEqual([...m.imageNamesOf(clubs)].sort(), ['a_1_hole.jpg', 'a_2_green.jpg']);
  assert.ok(m.holeHasContent({ number: 1, hazards: ['OB'] }));
  assert.ok(!m.holeHasContent({ number: 1, distances: {}, hazards: [] }));
});

test('그림만 같은 이름으로 바꿔도 그 그림을 쓰는 골프장은 고친 것(수정 시각이 오름)', () => {
  const state = openBackup(sampleText);
  state.backup.clubs[0].nines[0].holes = [{ number: 1, holeImage: 'nine-a_1_hole.jpg' }];
  const opened = buildSave(state, 1).state;
  assert.equal(changesOf(opened).changedClubs.length, 0);
  opened.images.set('nine-a_1_hole.jpg', new Uint8Array([5]));
  opened.changedImages.add('nine-a_1_hole.jpg');
  assert.deepEqual(changesOf(opened).changedClubs.map((c) => c.id), ['club-sample']);
  assert.equal(JSON.parse(buildSave(opened, 99).text).clubs[0].updatedAt, 99);
});
