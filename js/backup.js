// 폰 백업 파일(v2) 열기·바뀐 것 찾기·저장. 화면 코드 없이 Node 에서 테스트한다(test/backup.test.js).
//
// 폰의 [백업 파일 가져오기] 는 updatedAt 이 더 큰 라운드·골프장만 덮어쓰고 지우지 않는다(앱 Backup.kt planImport).
// 그래서 저장할 때 **고친 항목만** updatedAt 을 지금 시각으로 올린다. 모르는 필드는 읽은 그대로 다시 쓴다.

import { clubProblems } from './model.js';

export const SUPPORTED_VERSION = 2;

export class BackupError extends Error {}

/** 비교용: 항목을 문자열로. 키 순서는 읽은 그대로 유지되므로 같은 내용이면 같은 문자열이다. */
const snapshot = (item) => JSON.stringify(item);

/**
 * 백업 파일 내용을 연다. 결과: { backup, originals } — originals 는 처음 연 상태(바뀐 것 찾기용).
 * 이 앱의 백업이 아니거나 지원하지 않는 버전이면 BackupError.
 */
export function openBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BackupError('골프 스코어 백업 파일이 아닙니다(JSON 을 읽을 수 없음)');
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.rounds) || typeof data.version !== 'number') {
    throw new BackupError('골프 스코어 백업 파일이 아닙니다');
  }
  if (data.version > SUPPORTED_VERSION) {
    throw new BackupError(`더 새 버전의 앱에서 만든 백업입니다(v${data.version}). 웹 도구를 새로 고쳐 주세요`);
  }
  if (data.version < SUPPORTED_VERSION) {
    throw new BackupError(`옛 형식의 백업입니다(v${data.version}). 폰에서 한 번 가져온 뒤 다시 백업해 주세요`);
  }
  if (!Array.isArray(data.clubs)) data.clubs = [];
  return { backup: data, originals: originalsOf(data) };
}

function originalsOf(backup) {
  return {
    rounds: new Map(backup.rounds.map((r) => [r.id, snapshot(r)])),
    clubs: new Map(backup.clubs.map((c) => [c.id, snapshot(c)])),
  };
}

/** 처음 연 상태와 비교해 바뀐 것. */
export function changesOf({ backup, originals }) {
  const newClubs = backup.clubs.filter((c) => !originals.clubs.has(c.id));
  const changedClubs = backup.clubs.filter((c) => originals.clubs.has(c.id) && originals.clubs.get(c.id) !== snapshot(c));
  const changedRounds = backup.rounds.filter((r) => originals.rounds.has(r.id) && originals.rounds.get(r.id) !== snapshot(r));
  return { newClubs, changedClubs, changedRounds };
}

/** 저장 전에 막아야 할 문제(골프장 검사). [{ name, problems }] */
export function saveProblems({ backup }) {
  return backup.clubs.map((c) => ({ name: c.name || '(이름 없음)', problems: clubProblems(c) })).filter((x) => x.problems.length);
}

/**
 * 저장할 백업 파일 내용을 만든다. 고친·새로 만든 항목의 updatedAt 을 [now] 로 올린다.
 * 결과: { text, state } — state 는 저장한 내용을 새 기준(originals)으로 삼은 상태.
 */
export function buildSave(state, now = Date.now()) {
  const { newClubs, changedClubs, changedRounds } = changesOf(state);
  const bump = new Set([...newClubs, ...changedClubs, ...changedRounds].map((x) => x.id));
  const backup = {
    ...state.backup,
    exportedAt: now,
    clubs: state.backup.clubs.map((c) => (bump.has(c.id) ? { ...c, updatedAt: now } : c)),
    rounds: state.backup.rounds.map((r) => (bump.has(r.id) ? { ...r, updatedAt: now } : r)),
  };
  // 앱도 줄바꿈 없는 JSON 으로 쓴다(파일이 작다).
  return { text: JSON.stringify(backup), state: { backup, originals: originalsOf(backup) } };
}

/** 저장 파일 이름: golfscore-backup-YYYYMMDD-web.json */
export function saveFileName(now = Date.now()) {
  const t = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `golfscore-backup-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-web.json`;
}
