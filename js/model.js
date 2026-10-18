// 골프장·라운드 계산 규칙. 앱(shared 모듈)의 규칙을 그대로 옮긴 것이라, 바꿀 때는 앱과 함께 바꾼다.
// 앱 쪽 함수 이름을 주석에 적어 둔다. 화면 코드 없이 Node 에서 테스트한다(test/model.test.js).

export const NINE_HOLES = 9;
export const PAR_RANGE = [3, 6];
export const DEFAULT_PARS_18 = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5];
const MAX_PUTTS = 9;
const MAX_PENALTIES = 9;
const MAX_STROKES = 20;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const newId = () => crypto.randomUUID();

// ── 입력 읽기 (Course.kt) ──

/** 숫자가 아닌 글자는 모두 구분자로 본다(폰 숫자 키패드에 공백이 없어 쉼표·점으로 적음). */
export function splitNumbers(text) {
  return String(text ?? '').split(/[^0-9]+/).filter((s) => s.length > 0);
}

export function defaultPars(holeCount) {
  if (holeCount === 18) return DEFAULT_PARS_18.slice();
  if (holeCount === 9) return DEFAULT_PARS_18.slice(0, 9);
  return Array(holeCount).fill(4);
}

/** parsePars: 모자라거나 범위를 벗어난 값은 기본 파 배치로 채운다. */
export function parsePars(text, holeCount) {
  const defaults = defaultPars(holeCount);
  const parsed = splitNumbers(text).map(Number);
  return Array.from({ length: holeCount }, (_, i) => {
    const v = parsed[i];
    return v >= PAR_RANGE[0] && v <= PAR_RANGE[1] ? v : defaults[i] ?? 4;
  });
}

/**
 * parseStrokeIndexes: 홀 수만큼, 1~18, 서로 겹치지 않아야 한다. 모자란 값을 채우지 않는다.
 * 결과: { kind: 'blank' } | { kind: 'invalid' } | { kind: 'valid', indexes }
 */
export function parseStrokeIndexes(text, holeCount) {
  if (String(text ?? '').trim() === '') return { kind: 'blank' };
  const values = splitNumbers(text).map(Number);
  const valid = values.length === holeCount && values.every((v) => v >= 1 && v <= 18) && new Set(values).size === holeCount;
  return valid ? { kind: 'valid', indexes: values } : { kind: 'invalid' };
}

// ── 홀 (Round.kt HoleScore, ShotRules.kt) ──

export const isPlayed = (hole) => hole.strokes > 0;

/** HoleScore.withEstimatedGir: 친 홀이고 퍼팅을 적었으면 GIR 을 추정한다. */
export function withEstimatedGir(hole) {
  if (isPlayed(hole) && hole.putts > 0) {
    return { ...hole, greenInRegulation: hole.strokes - hole.putts <= hole.par - 2, girEstimated: hole.puttsEstimated };
  }
  return hole;
}

/** withSuggestedStrokes: 샷 기록으로 타수를 채우는 홀이면 샷 수 + 퍼팅 + 벌타 + 빠뜨린 샷. */
export function withSuggestedStrokes(hole) {
  const shots = hole.shots ?? [];
  const extra = hole.extraStrokes ?? 0;
  if (hole.strokesEdited) return hole;
  if (shots.length === 0 && extra === 0) return hole;
  if (shots.length === 0) {
    return withEstimatedGir({ ...hole, strokes: Math.max(0, extra + hole.putts + hole.penalties), extraStrokes: 0 });
  }
  return withEstimatedGir({ ...hole, strokes: Math.max(1, shots.length + hole.putts + hole.penalties + extra) });
}

/** RoundDetailViewModel.setPar: 3~6. 파3 이 되면 페어웨이를 비운다. */
export function setPar(hole, par) {
  const p = clamp(Math.round(par), PAR_RANGE[0], PAR_RANGE[1]);
  return withEstimatedGir({ ...hole, par: p, fairwayHit: p === 3 ? null : hole.fairwayHit });
}

/**
 * 웹에서 타수를 적는다. 0 이면 치지 않은 홀로 되돌리고(withUserStrokes(0)),
 * 그 밖에는 폰의 파·보기·더블 칩과 같이 최종 타수로 정한다(withFinalStrokes): 샷이 있는 홀은 고정.
 */
export function setStrokes(hole, strokes) {
  const s = clamp(Math.round(strokes), 0, MAX_STROKES);
  const shots = hole.shots ?? [];
  if (s <= 0) {
    return {
      ...hole,
      strokes: 0,
      putts: 0,
      fairwayHit: null,
      greenInRegulation: false,
      penalties: 0,
      puttsEstimated: false,
      girEstimated: false,
      strokesEdited: shots.length > 0,
      extraStrokes: 0,
    };
  }
  const trimmed = { ...hole, putts: Math.min(hole.putts, s) };
  if (shots.length === 0) return withEstimatedGir({ ...trimmed, strokes: s });
  return withEstimatedGir({ ...trimmed, strokes: s, strokesEdited: true });
}

/** withUserPutts: 직접 적은 퍼팅은 실제값이라 추정 표시를 푼다. */
export function setPutts(hole, putts) {
  const suggesting = (hole.shots ?? []).length > 0 && !hole.strokesEdited;
  const max = suggesting ? MAX_PUTTS : Math.max(0, hole.strokes);
  return withSuggestedStrokes(withEstimatedGir({ ...hole, putts: clamp(Math.round(putts), 0, max), puttsEstimated: false }));
}

/** withUserPenalties */
export function setPenalties(hole, penalties) {
  return withSuggestedStrokes({ ...hole, penalties: clamp(Math.round(penalties), 0, MAX_PENALTIES) });
}

/** toggleGir: 직접 바꾼 GIR 은 추정값이 아니다. */
export function setGir(hole, gir) {
  return { ...hole, greenInRegulation: !!gir, girEstimated: false };
}

/** toggleFairway: 파3 는 집계하지 않는다. */
export function setFairway(hole, hit) {
  if (hole.par === 3) return hole;
  return { ...hole, fairwayHit: hit === null ? null : !!hit };
}

// ── 라운드 (Round.kt) ──

export const playedHoles = (round) => round.holes.filter(isPlayed);
export const totalStrokes = (round) => playedHoles(round).reduce((s, h) => s + h.strokes, 0);
export const toPar = (round) => totalStrokes(round) - playedHoles(round).reduce((s, h) => s + h.par, 0);

export function formatToPar(v) {
  if (v === 0) return 'E';
  return v > 0 ? `+${v}` : `${v}`;
}

/** 라운드 홀 하나를 고친다(Round.updateHole). updatedAt 은 저장할 때 올린다. */
export function updateHole(round, number, transform) {
  return { ...round, holes: round.holes.map((h) => (h.number === number ? transform(h) : h)) };
}

/** withStrokeIndexes 와 라운드 정보 수정: 홀별 핸디캡을 각 홀에. null 이면 지운다. */
export function setRoundStrokeIndexes(round, indexes) {
  return { ...round, holes: round.holes.map((h, i) => ({ ...h, strokeIndex: indexes ? indexes[i] ?? null : null })) };
}

/** RoundDate.withPickedDate: 날짜만 바꾸고 시각은 그대로 둔다(로컬 시간 기준). */
export function withPickedDate(dateMillis, isoDay) {
  const [y, m, d] = isoDay.split('-').map(Number);
  const t = new Date(dateMillis);
  return new Date(y, m - 1, d, t.getHours(), t.getMinutes(), t.getSeconds(), t.getMilliseconds()).getTime();
}

export function isoDay(dateMillis) {
  const t = new Date(dateMillis);
  const pad = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

// ── 골프장·9홀 코스 조합 (GolfClub.kt) ──

export const nineOf = (club, id) => (id == null ? null : club.nines.find((n) => n.id === id) ?? null);

/** combinations: 9홀 코스가 1개면 같은 코스 두 번, 2개 이상이면 서로 다른 두 코스의 모든 순서쌍. */
export function combinations(club) {
  if (club.nines.length === 1) return [{ front: club.nines[0], back: club.nines[0] }];
  return club.nines.flatMap((front) => club.nines.filter((n) => n.id !== front.id).map((back) => ({ front, back })));
}

/** startOptions: 18홀 조합 다음에 9홀(코스 하나씩). */
export const startOptions = (club) => [...combinations(club), ...club.nines.map((front) => ({ front, back: null }))];

export const comboHoleCount = (combo) => (combo.back ? NINE_HOLES * 2 : NINE_HOLES);
export const comboPars = (combo) => [...combo.front.pars, ...(combo.back?.pars ?? [])];
export const comboLabel = (combo) => (combo.back ? `${combo.front.name} → ${combo.back.name}` : combo.front.name);
export const roundName = (club, combo) => `${club.name} (${[combo.front.name, combo.back?.name].filter(Boolean).join('·')})`;

/** NineCombo.strokeIndexes: 전반+후반. 한쪽을 모르거나 1~18 안에서 겹치면 null. */
export function comboStrokeIndexes(combo) {
  const front = combo.front.strokeIndexes;
  if (!front) return null;
  let all = front;
  if (combo.back) {
    if (!combo.back.strokeIndexes) return null;
    all = [...front, ...combo.back.strokeIndexes];
  }
  const valid = all.length === comboHoleCount(combo) && all.every((v) => v >= 1 && v <= 18) && new Set(all).size === all.length;
  return valid ? all : null;
}

/** Round.parMismatches: 라운드 파와 조합 파가 다른 홀 수(홀 수가 다르면 +1). */
export function parMismatches(round, combo) {
  const pars = comboPars(combo);
  const diff = round.holes.reduce((n, h, i) => n + (i < pars.length && h.par !== pars[i] ? 1 : 0), 0);
  return diff + (round.holes.length !== comboHoleCount(combo) ? 1 : 0);
}

/** Round.withNines: 홀 수가 같아야 한다. 이름은 그대로, 파는 replacePars 때만 바꾼다. */
export function withNines(round, club, combo, replacePars = false) {
  if (round.holes.length !== comboHoleCount(combo)) {
    throw new Error(`홀 수가 다릅니다: ${round.holes.length} ≠ ${comboHoleCount(combo)}`);
  }
  const pars = comboPars(combo);
  const holes = replacePars ? round.holes.map((h, i) => (h.par === pars[i] ? h : setPar(h, pars[i]))) : round.holes;
  return { ...round, courseId: club.id, frontNineId: combo.front.id, backNineId: combo.back?.id ?? null, holes };
}

/** Round.withoutNines: 지정을 푼다. 골프장 연결은 남긴다. */
export const withoutNines = (round) => ({ ...round, frontNineId: null, backNineId: null });

/** 라운드가 지정된 골프장의 조합. 지정이 없거나 코스가 지워졌으면 null. */
export function roundCombo(round, clubs) {
  if (!round.frontNineId) return null;
  const club = clubs.find((c) => c.id === round.courseId);
  if (!club) return null;
  const front = nineOf(club, round.frontNineId);
  if (!front) return null;
  const back = round.backNineId ? nineOf(club, round.backNineId) : null;
  if (round.backNineId && !back) return null;
  return { club, combo: { front, back } };
}

/** 9홀 코스를 지우면 끊기는 라운드 수. */
export const roundsUsingNine = (rounds, clubId, nineId) =>
  rounds.filter((r) => r.courseId === clubId && (r.frontNineId === nineId || r.backNineId === nineId)).length;

// ── 검사 ──

/** 9홀 코스 하나의 문제. 빈 배열이면 문제없음. */
export function nineProblems(nine) {
  const problems = [];
  if (!String(nine.name ?? '').trim()) problems.push('코스 이름이 비어 있어요');
  if (!Array.isArray(nine.pars) || nine.pars.length !== NINE_HOLES) problems.push('홀별 파는 9개여야 해요');
  else if (nine.pars.some((p) => p < PAR_RANGE[0] || p > PAR_RANGE[1])) problems.push('파는 3~6 이어야 해요');
  if (nine.strokeIndexes != null) {
    const si = nine.strokeIndexes;
    const ok = si.length === NINE_HOLES && si.every((v) => v >= 1 && v <= 18) && new Set(si).size === NINE_HOLES;
    if (!ok) problems.push('HCDP 는 9개, 1~18, 서로 다른 숫자여야 해요');
  }
  if (nine.courseRating != null && !(nine.courseRating >= NINE_RATING[0] && nine.courseRating <= NINE_RATING[1])) {
    problems.push(`코스 레이팅은 ${NINE_RATING[0]}~${NINE_RATING[1]} 이어야 해요(9홀 값)`);
  }
  if (nine.slopeRating != null && !(Number.isInteger(nine.slopeRating) && nine.slopeRating >= 55 && nine.slopeRating <= 155)) {
    problems.push('슬로프는 55~155 정수여야 해요');
  }
  return problems;
}

export function clubProblems(club) {
  const problems = [];
  if (!String(club.name ?? '').trim()) problems.push('골프장 이름이 비어 있어요');
  if (!club.nines?.length) problems.push('9홀 코스가 하나 이상 있어야 해요');
  club.nines?.forEach((n, i) => nineProblems(n).forEach((p) => problems.push(`${ordinalCourse(i)}: ${p}`)));
  return problems;
}

/** "1st 코스", "2nd 코스", "3rd 코스" … (폰 nineOrdinalLabel 과 같다) */
export function ordinalCourse(index) {
  const n = index + 1;
  let suffix = 'th';
  if (!(n % 100 >= 11 && n % 100 <= 13)) suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix} 코스`;
}

// ── 레이팅·슬로프 (CourseForm.kt parseRating, parseSlope) ──

/** 코스 레이팅: 30~90, 쉼표로 적어도 받는다. 비었거나 이상하면 null. */
export function parseRating(text) {
  const v = Number(String(text ?? '').trim().replace(',', '.'));
  return String(text ?? '').trim() !== '' && Number.isFinite(v) && v >= 30 && v <= 90 ? v : null;
}

/** 슬로프: 55~155 정수(Handicap.SLOPE_RANGE). */
export function parseSlope(text) {
  const s = String(text ?? '').trim();
  const v = Number(s);
  return /^\d+$/.test(s) && v >= 55 && v <= 155 ? v : null;
}

// ── 9홀 코스 레이팅·슬로프 (앱 Nine.courseRating·slopeRating, docs/spec-web-tool.md 10-2) ──

/** 9홀 코스 레이팅 범위. 9홀 값은 보통 30대 중반이라 18홀 범위(30~90)로는 실수를 못 잡는다. */
export const NINE_RATING = [15, 45];

/** 9홀 코스 레이팅 입력. 비었거나 범위 밖이면 null(검사는 nineRatingInput 으로). */
export function parseNineRating(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  const v = Number(s);
  return s !== '' && Number.isFinite(v) && v >= NINE_RATING[0] && v <= NINE_RATING[1] ? Math.round(v * 10) / 10 : null;
}

/**
 * 조합의 18홀(또는 9홀) 코스 레이팅·슬로프(WHS): 레이팅 = 전반 + 후반(소수 첫째 자리), 슬로프 = 두 값의 평균(반올림).
 * 9홀 라운드는 그 코스 값 그대로. 한쪽이라도 모르면 그 값은 null.
 */
export function comboRatings(combo) {
  const { front, back } = combo;
  if (!back) return { courseRating: front.courseRating ?? null, slopeRating: front.slopeRating ?? null };
  const rating = front.courseRating != null && back.courseRating != null ? Math.round((front.courseRating + back.courseRating) * 10) / 10 : null;
  const slope = front.slopeRating != null && back.slopeRating != null ? Math.round((front.slopeRating + back.slopeRating) / 2) : null;
  return { courseRating: rating, slopeRating: slope };
}

/** 라운드의 레이팅·슬로프가 비어 있으면 조합 값으로 채운다. 이미 있는 값은 그대로 둔다. */
export function withComboRatingsIfEmpty(round, combo) {
  const r = comboRatings(combo);
  return {
    ...round,
    courseRating: round.courseRating ?? r.courseRating,
    slopeRating: round.slopeRating ?? r.slopeRating,
  };
}

// ── 야디지북 (앱 Yardage.kt, 앱 저장소 docs/spec-yardage-book.md) ──

export const YARD_M = 0.9144;
export const DEFAULT_TEES = ['블랙', '블루', '화이트', '레드'];
/** 티 거리 범위(미터). 야드로 적으면 미터로 바꾼 값으로 본다. */
export const DISTANCE_RANGE = [1, 700];
/** 넣는 그림의 긴 변 최대(px). 원본이 더 작으면 원본 크기 그대로(키우지 않음, 2026-10-18 결정). */
export const IMAGE_MAX_SIDE = 1600;
export const IMAGE_QUALITY = 0.8;

export const ydToM = (yd) => Math.round(yd * YARD_M);
export const mToYd = (m) => Math.round(m / YARD_M);

/** 그림 파일 이름: <9홀 코스 id>_<홀>_hole.jpg / …_green.jpg (YardageImages.name) */
export const imageName = (nineId, number, kind) => `${nineId}_${number}_${kind}.jpg`;

/** 파일 이름으로 써도 안전한지(YardageImages.isSafe 와 같음). */
export const isSafeImageName = (name) => /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,150}\.jpg$/.test(name) && !name.includes('..');

/** 골프장들이 쓰는 그림 이름 전부. */
export function imageNamesOf(clubs) {
  const names = new Set();
  for (const club of clubs) {
    for (const nine of club.nines ?? []) {
      for (const hole of nine.holes ?? []) {
        if (hole.holeImage) names.add(hole.holeImage);
        if (hole.greenImage) names.add(hole.greenImage);
      }
    }
  }
  return names;
}

/** 거리·글·그림 중 하나라도 있으면 true (HoleInfo.hasContent). */
export function holeHasContent(hole) {
  if (!hole) return false;
  return Object.keys(hole.distances ?? {}).length > 0 || !!hole.description?.trim() || (hole.hazards ?? []).length > 0 ||
    !!hole.greenNote?.trim() || !!hole.myNote?.trim() || !!hole.holeImage || !!hole.greenImage;
}

export const nineHasYardage = (nine) => (nine.holes ?? []).some(holeHasContent);

/** 거리 칸: 비면 null, 정수가 아니거나 범위 밖이면 NaN, 아니면 미터. yards 면 야드로 적은 것으로 보고 미터로 바꾼다. */
export function parseDistance(text, yards = false) {
  const s = String(text ?? '').trim();
  if (s === '') return null;
  if (!/^\d+$/.test(s)) return NaN;
  const m = yards ? ydToM(Number(s)) : Number(s);
  return m >= DISTANCE_RANGE[0] && m <= DISTANCE_RANGE[1] ? m : NaN;
}

/** 위험 요소 글: 쉼표·줄바꿈으로 나눈 목록. */
export const parseHazards = (text) => String(text ?? '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

/**
 * 수집 가이드의 그림 파일 이름 규칙 `코스이름_홀번호_hole.jpg` / `코스이름_홀번호_green.jpg` 를 읽는다.
 * jpg·jpeg·png·webp 를 받는다. 맞지 않으면 null. 결과: { course, number, kind }
 */
export function parseImageFileName(fileName) {
  const match = /^(.+)_([1-9])_(hole|green)\.(jpe?g|png|webp)$/i.exec(String(fileName ?? '').trim());
  if (!match) return null;
  return { course: match[1].trim(), number: Number(match[2]), kind: match[3].toLowerCase() };
}

/** 그림 크기 정하기: 긴 변이 max 보다 크면 max 로 줄이고, 작으면 그대로. 결과: { width, height, resized } */
export function fitImageSize(width, height, max = IMAGE_MAX_SIDE) {
  const side = Math.max(width, height);
  if (side <= max) return { width, height, resized: false };
  const scale = max / side;
  return { width: Math.round(width * scale), height: Math.round(height * scale), resized: true };
}
