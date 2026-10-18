// 백업 열기·바뀐 것 찾기·저장. 고친 항목만 updatedAt 이 오르고, 모르는 필드는 그대로 남는지.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BackupError, buildSave, changesOf, openBackup, saveFileName, saveProblems } from '../js/backup.js';
import * as m from '../js/model.js';

const sampleText = readFileSync(new URL('../examples/sample-backup.json', import.meta.url), 'utf8');

test('예시 백업을 열면 라운드·골프장이 그대로', () => {
  const { backup } = openBackup(sampleText);
  assert.equal(backup.version, 2);
  assert.equal(backup.rounds.length, 3);
  assert.equal(backup.clubs[0].nines.length, 3);
});

test('이 앱의 백업이 아니거나 버전이 다르면 연다고 하지 않는다', () => {
  assert.throws(() => openBackup('hello'), BackupError);
  assert.throws(() => openBackup('{"foo":1}'), BackupError);
  assert.throws(() => openBackup('{"version":1,"exportedAt":0,"rounds":[],"courses":[]}'), /옛 형식/);
  assert.throws(() => openBackup('{"version":4,"exportedAt":0,"rounds":[]}'), /더 새 버전/);
});

test('아무것도 안 고치면 바뀐 것이 없고, 저장해도 수정 시각이 그대로', () => {
  const state = openBackup(sampleText);
  assert.deepEqual(changesOf(state), { newClubs: [], changedClubs: [], changedRounds: [], deletions: [] });
  const saved = JSON.parse(buildSave(state, 999).text);
  const original = JSON.parse(sampleText);
  assert.deepEqual(saved.rounds, original.rounds);
  assert.deepEqual(saved.clubs, original.clubs);
  assert.equal(saved.exportedAt, 999);
});

test('고친 라운드·골프장과 새 골프장만 수정 시각이 오른다', () => {
  const state = openBackup(sampleText);
  const b = state.backup;
  b.rounds = b.rounds.map((r) => (r.id === 'round-old' ? m.updateHole(r, 1, (h) => m.setStrokes(h, 7)) : r));
  b.clubs = [...b.clubs, { id: 'new-club', name: '새 골프장', nines: [{ id: 'n', name: 'OUT', pars: m.defaultPars(9), strokeIndexes: null }], updatedAt: 0 }];

  const changes = changesOf(state);
  assert.deepEqual(changes.changedRounds.map((r) => r.id), ['round-old']);
  assert.deepEqual(changes.newClubs.map((c) => c.id), ['new-club']);

  const now = 5_000_000_000_000;
  const { text, state: after } = buildSave(state, now);
  const saved = JSON.parse(text);
  assert.equal(saved.rounds.find((r) => r.id === 'round-old').updatedAt, now);
  assert.notEqual(saved.rounds.find((r) => r.id === 'round-played').updatedAt, now);
  assert.equal(saved.clubs.find((c) => c.id === 'new-club').updatedAt, now);
  assert.notEqual(saved.clubs.find((c) => c.id === 'club-sample').updatedAt, now);
  // 저장한 내용이 새 기준이 되어, 바로 다시 보면 바뀐 것이 없다
  assert.deepEqual(changesOf(after), { newClubs: [], changedClubs: [], changedRounds: [], deletions: [] });
});

test('모르는 필드(앞으로 생길 값)는 읽은 그대로 다시 쓴다', () => {
  const data = JSON.parse(sampleText);
  data.futureTopLevel = { a: 1 };
  data.rounds[0].futureField = 'x';
  data.rounds[0].holes[0].futureHoleField = [1, 2];
  const state = openBackup(JSON.stringify(data));
  state.backup.rounds[0] = m.updateHole(state.backup.rounds[0], 1, (h) => m.setPar(h, 5));
  const saved = JSON.parse(buildSave(state, 1).text);
  assert.deepEqual(saved.futureTopLevel, { a: 1 });
  assert.equal(saved.rounds[0].futureField, 'x');
  assert.deepEqual(saved.rounds[0].holes[0].futureHoleField, [1, 2]);
});

test('샷 기록은 고친 라운드에서도 그대로', () => {
  const state = openBackup(sampleText);
  const played = state.backup.rounds.find((r) => r.id === 'round-played');
  const before = JSON.stringify(played.holes[0].shots);
  state.backup.rounds = state.backup.rounds.map((r) => (r.id === played.id ? m.updateHole(r, 1, (h) => m.setPutts(h, 1)) : r));
  const saved = JSON.parse(buildSave(state, 1).text);
  assert.equal(JSON.stringify(saved.rounds.find((r) => r.id === played.id).holes[0].shots), before);
});

test('저장 전 검사: 잘못된 골프장을 알려 준다', () => {
  const state = openBackup(sampleText);
  state.backup.clubs[0] = { ...state.backup.clubs[0], name: '' };
  assert.equal(saveProblems(state).length, 1);
});

test('저장 파일 이름', () => {
  assert.equal(saveFileName(new Date(2026, 9, 17, 9).getTime()), 'golfscore-backup-20261017-web.json');
});
