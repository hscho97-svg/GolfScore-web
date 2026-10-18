// 폰 백업 파일(v2·v3, .json 또는 그림을 묶은 .zip) 열기·바뀐 것 찾기·저장. 화면 코드 없이 Node 에서 테스트한다(test/backup.test.js).
//
// 폰의 [백업 파일 가져오기] 는 updatedAt 이 더 큰 라운드·골프장만 덮어쓰고 지우지 않는다(앱 Backup.kt planImport).
// 그래서 저장할 때 **고친 항목만** updatedAt 을 지금 시각으로 올린다. 모르는 필드는 읽은 그대로 다시 쓴다.
// v3(앱 1.9, 앱 저장소 docs/spec-yardage-book.md): 야디지북(골프장 tees, 9홀 코스 holes), 그림 zip, 지운 항목(deleted).
// 웹에서 지운 라운드·골프장은 deleted 에 남기고, 폰은 가져올 때 확인 창을 거쳐 지운다.

import { clubProblems, imageNamesOf, isSafeImageName } from './model.js';
import { isZip, readZip, writeZip } from './zip.js';

export const SUPPORTED_VERSION = 3;
export const JSON_ENTRY = 'backup.json';
export const IMAGE_DIR = 'images/';

export class BackupError extends Error {}

/** 비교용: 항목을 문자열로. 키 순서는 읽은 그대로 유지되므로 같은 내용이면 같은 문자열이다. */
const snapshot = (item) => JSON.stringify(item);

/**
 * 백업 파일 내용(JSON 글)을 연다. 결과 상태:
 * { backup, originals, images: Map<그림 이름, Uint8Array>, changedImages: Set, trash: [] }
 * originals 는 처음 연 상태(바뀐 것 찾기용). 이 앱의 백업이 아니거나 지원하지 않는 버전이면 BackupError.
 * v2 파일은 야디지북·지운 항목이 없는 v3 로 연다(저장하면 v3).
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
  if (data.version < 2) {
    throw new BackupError(`옛 형식의 백업입니다(v${data.version}). 폰에서 한 번 가져온 뒤 다시 백업해 주세요`);
  }
  if (!Array.isArray(data.clubs)) data.clubs = [];
  if (!Array.isArray(data.deleted)) data.deleted = [];
  return { backup: data, originals: originalsOf(data), images: new Map(), changedImages: new Set(), trash: [] };
}

/**
 * 파일 내용(바이트)을 연다. zip 이면 backup.json 과 images/ 의 그림을 읽는다. 결과: openBackup 과 같고 fromZip 이 붙는다.
 * 그림은 이름이 안전한 jpg 만 받는다.
 */
export async function openBackupBytes(bytes) {
  if (!isZip(bytes)) return { ...openBackup(new TextDecoder().decode(bytes)), fromZip: false };
  let files;
  try {
    files = await readZip(bytes);
  } catch (e) {
    throw new BackupError(`zip 파일을 읽지 못했습니다: ${e.message}`);
  }
  const json = files.get(JSON_ENTRY);
  if (!json) throw new BackupError('골프 스코어 백업 zip 이 아닙니다(backup.json 없음)');
  const state = openBackup(new TextDecoder().decode(json));
  for (const [path, data] of files) {
    if (!path.startsWith(IMAGE_DIR)) continue;
    const name = path.slice(IMAGE_DIR.length);
    if (isSafeImageName(name)) state.images.set(name, data);
  }
  return { ...state, fromZip: true };
}

const deletionKey = (d) => `${d.kind}:${d.id}`;

function originalsOf(backup) {
  return {
    rounds: new Map(backup.rounds.map((r) => [r.id, snapshot(r)])),
    clubs: new Map(backup.clubs.map((c) => [c.id, snapshot(c)])),
    deleted: new Set((backup.deleted ?? []).map(deletionKey)),
  };
}

/**
 * 처음 연 상태와 비교해 바뀐 것. deletions: 이번에 지운 것 [{ kind, id, name }].
 * 그림을 같은 이름으로 바꿔 넣으면 골프장 JSON 은 그대로라, 바꾼 그림(changedImages)을 쓰는 골프장도 고친 것으로 본다
 * (폰은 수정 시각이 오른 골프장의 그림만 덮어쓴다).
 */
export function changesOf({ backup, originals, trash = [], changedImages = new Set() }) {
  const newClubs = backup.clubs.filter((c) => !originals.clubs.has(c.id));
  const touchesImage = (c) => changedImages.size > 0 && [...imageNamesOf([c])].some((n) => changedImages.has(n));
  const changedClubs = backup.clubs.filter((c) => originals.clubs.has(c.id) && (originals.clubs.get(c.id) !== snapshot(c) || touchesImage(c)));
  const changedRounds = backup.rounds.filter((r) => originals.rounds.has(r.id) && originals.rounds.get(r.id) !== snapshot(r));
  const deletions = trash.filter((t) => t.marked);
  return { newClubs, changedClubs, changedRounds, deletions };
}

export const changeCount = (c) => c.newClubs.length + c.changedClubs.length + c.changedRounds.length + c.deletions.length;

const listKeyOf = (kind) => (kind === 'club' ? 'clubs' : 'rounds');

/**
 * 라운드(kind 'round')·골프장('club')을 지운다. 목록에서 빼고 deleted 에 남긴다(지운 시각은 저장할 때 정함).
 * 저장 전에는 undoDelete 로 되돌릴 수 있다. 처음 연 파일에 없던(이번에 새로 만든) 골프장은 표시 없이 그냥 뺀다.
 */
export function deleteItem(state, kind, id) {
  const listKey = listKeyOf(kind);
  const item = state.backup[listKey].find((x) => x.id === id);
  if (!item) return;
  state.backup[listKey] = state.backup[listKey].filter((x) => x.id !== id);
  const marked = state.originals[listKey].has(id);
  const name = kind === 'club' ? item.name : item.courseName;
  state.trash = [...(state.trash ?? []), { kind, id, name, date: item.date ?? null, item, marked }];
  if (marked) state.backup.deleted = [...state.backup.deleted, { kind, id, deletedAt: 0 }];
}

/** 지운 것을 되돌린다(저장 전). */
export function undoDelete(state, kind, id) {
  const entry = (state.trash ?? []).find((t) => t.kind === kind && t.id === id);
  if (!entry) return;
  const listKey = listKeyOf(kind);
  state.backup[listKey] = [...state.backup[listKey], entry.item];
  state.trash = state.trash.filter((t) => t !== entry);
  state.backup.deleted = state.backup.deleted.filter((d) => !(d.kind === kind && d.id === id && d.deletedAt === 0));
}

/** 저장 전에 막아야 할 문제(골프장 검사). [{ name, problems }] */
export function saveProblems({ backup }) {
  return backup.clubs.map((c) => ({ name: c.name || '(이름 없음)', problems: clubProblems(c) })).filter((x) => x.problems.length);
}

/**
 * 저장할 백업 파일 내용을 만든다. 고친·새로 만든 항목의 updatedAt 을 [now] 로 올리고, 이번에 지운 것의 시각을 [now] 로 정한다.
 * 결과: { text, backup, state } — state 는 저장한 내용을 새 기준(originals)으로 삼은 상태.
 */
export function buildSave(state, now = Date.now()) {
  const { newClubs, changedClubs, changedRounds } = changesOf(state);
  const bump = new Set([...newClubs, ...changedClubs, ...changedRounds].map((x) => x.id));
  const backup = {
    ...state.backup,
    version: SUPPORTED_VERSION,
    exportedAt: now,
    clubs: state.backup.clubs.map((c) => (bump.has(c.id) ? { ...c, updatedAt: now } : c)),
    rounds: state.backup.rounds.map((r) => (bump.has(r.id) ? { ...r, updatedAt: now } : r)),
    // 폰은 지운 시각 이후에 폰에서 고친 것은 지우지 않는다.
    deleted: (state.backup.deleted ?? []).map((d) => (d.deletedAt === 0 ? { ...d, deletedAt: now } : d)),
  };
  // 앱도 줄바꿈 없는 JSON 으로 쓴다(파일이 작다).
  const text = JSON.stringify(backup);
  return {
    text,
    backup,
    state: { ...state, backup, originals: originalsOf(backup), changedImages: new Set(), trash: [] },
  };
}

/**
 * 저장한 JSON 과 골프장들이 쓰는 그림을 zip 으로 묶는다. 이 파일에 없는 그림(폰에만 있는 것)은 빼고, 몇 개 빠졌는지 돌려준다.
 * 결과: { bytes, images, missing }
 */
export function buildZip(text, backup, images) {
  const names = [...imageNamesOf(backup.clubs)].sort();
  const present = names.filter((n) => images.has(n));
  const bytes = writeZip([
    { name: JSON_ENTRY, bytes: new TextEncoder().encode(text) },
    ...present.map((n) => ({ name: IMAGE_DIR + n, bytes: images.get(n) })),
  ]);
  return { bytes, images: present.length, missing: names.length - present.length };
}

/** 저장 파일 이름: golfscore-backup-YYYYMMDD-web.json (zip 이면 .zip) */
export function saveFileName(now = Date.now(), ext = 'json') {
  const t = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `golfscore-backup-${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}-web.${ext}`;
}
