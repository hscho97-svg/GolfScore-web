// AI 결과 붙여넣기: golfscore-club/1 JSON → 골프장. 화면 코드 없이 Node 에서 테스트한다(test/clubimport.test.js).
// 규칙은 앱 저장소 docs/spec-club-import.md. 기존 골프장에 넣을 때는 JSON 에 든 9홀 코스를 통째로 바꾸되
// id·골프장 이름·내 공략 메모·그림·JSON 에 없는 9홀 코스는 그대로 둔다.

import * as m from './model.js';

export const FORMAT = 'golfscore-club/1';

export class ImportError extends Error {}

/** AI 답에서 JSON 을 꺼낸다: 첫 `{` 부터 짝이 맞는 `}` 까지(앞뒤 설명 문장·코드 블록 표시는 버림). */
export function extractJson(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start < 0) throw new ImportError('JSON 을 찾지 못했어요. AI 답을 그대로 붙여 넣어 주세요.');
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch (e) {
        throw new ImportError(`JSON 을 읽지 못했어요: ${e.message}`);
      }
    }
  }
  throw new ImportError('JSON 이 중간에 끊겼어요(여는 { 와 닫는 } 의 수가 다름). AI 답을 끝까지 복사했는지 확인해 주세요.');
}

/** 이름 맞추기: 공백을 모두 빼고 대소문자를 무시한다. */
export const sameName = (a, b) => normName(a) !== '' && normName(a) === normName(b);
const normName = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

/** 같은 이름의 골프장(없으면 null). */
export const findClub = (clubs, name) => clubs.find((c) => sameName(c.name, name)) ?? null;

/** 숫자 또는 숫자 글자("4", "35.6")만 받는다. 아니면 null. */
function num(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

const PLACEHOLDER_TEXT = /업데이트\s*예정|준비\s*중|coming\s*soon/i;
/** 글 칸: 비었거나 "코스 업데이트 예정" 같은 자리표시 글이면 null. */
function text(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && !PLACEHOLDER_TEXT.test(t) ? t : null;
}

const list = (v) => (Array.isArray(v) ? v : []);

/**
 * 형식 검사. 멈춰야 하는 문제(형식이 다름, 9홀 코스에 홀 9개가 아님 등)는 ImportError.
 * 결과는 홀을 number 순서로 맞춘 JSON 그대로.
 */
export function checkFormat(json) {
  if (!json || typeof json !== 'object') throw new ImportError('JSON 이 골프장 정보가 아니에요.');
  if (json.format !== FORMAT) throw new ImportError(`format 이 "${FORMAT}" 가 아니에요(${JSON.stringify(json.format ?? null)}). 웹 도구의 [프롬프트 복사] 로 받은 결과인지 확인해 주세요.`);
  const club = json.club;
  if (!club || typeof club !== 'object') throw new ImportError('club 이 없어요.');
  const nines = list(club.nines);
  if (nines.length === 0) throw new ImportError('9홀 코스(club.nines)가 없어요.');
  const seen = [];
  const sorted = nines.map((nine, i) => {
    const label = String(nine?.name ?? '').trim() || m.ordinalCourse(i);
    if (seen.some((x) => sameName(x, nine?.name))) throw new ImportError(`9홀 코스 이름이 겹쳐요: ${label}`);
    seen.push(nine?.name);
    const holes = list(nine?.holes);
    const numbers = holes.map((hole) => num(hole?.number));
    const ok = holes.length === m.NINE_HOLES && [...Array(m.NINE_HOLES)].every((_, k) => numbers.filter((x) => x === k + 1).length === 1);
    if (!ok) throw new ImportError(`${label}: 홀이 9개이고 number 가 1~9 한 번씩이어야 해요(지금 ${holes.length}개: ${numbers.join(', ')})`);
    return { ...nine, holes: [...holes].sort((a, b) => num(a.number) - num(b.number)) };
  });
  return { ...json, club: { ...club, nines: sorted } };
}

/** 그림 주소의 확장자(png·jpg·jpeg·webp). 모르면 jpg. */
function urlExt(url) {
  const path = String(url).split(/[?#]/)[0];
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : 'jpg';
}

/**
 * JSON(checkFormat 결과)으로 골프장을 만든다. existing 이 있으면 그 골프장에 넣는다.
 * 결과: { club, warnings, changes: { removed, changed }, images, reference, notes }
 *  - club: 저장할 모양의 골프장(편집 화면에 채울 값). 칸 검사(파 3~6 등)는 편집 화면이 한다
 *  - images: [{ label, fileName, url }] 그림 주소 목록
 */
export function buildClub(json, existing = null) {
  const src = json.club;
  const warnings = [];
  const unit = src.distanceUnit === 'yd' ? 'yd' : 'm';
  if (src.distanceUnit !== 'm' && src.distanceUnit !== 'yd') warnings.push('거리 단위(distanceUnit)가 없어 미터로 봤어요. 홈페이지의 단위를 확인해 주세요.');

  const tees = [];
  for (const t of list(src.tees)) {
    const name = String(t ?? '').trim();
    if (name && !tees.includes(name)) tees.push(name);
  }

  const oldNines = existing?.nines ?? [];
  const nines = src.nines.map((n) => {
    const label = String(n.name ?? '').trim();
    const old = oldNines.find((x) => sameName(x.name, n.name)) ?? null;
    return buildNine(n, old, label, tees, unit, warnings);
  });
  // JSON 에 없는 기존 9홀 코스는 그대로 뒤에 둔다
  const kept = oldNines.filter((x) => !nines.some((n) => n.id === x.id));
  const club = {
    ...(existing ?? {}),
    id: existing?.id ?? m.newId(),
    name: existing ? existing.name : String(src.name ?? '').trim(),
    nines: [...nines, ...kept],
    updatedAt: existing?.updatedAt ?? 0,
  };
  if (existing?.tees || tees.length) club.tees = tees;

  // 18홀 골프장: 보통 한 코스는 홀수, 다른 코스는 짝수 HCDP
  const full = nines.filter((n) => n.strokeIndexes);
  if (nines.length === 2 && full.length === 2) {
    const parity = (n) => new Set(n.strokeIndexes.map((v) => v % 2));
    const [a, b] = full.map(parity);
    if (!(a.size === 1 && b.size === 1 && [...a][0] !== [...b][0])) {
      warnings.push('HCDP 가 한 코스는 홀수, 다른 코스는 짝수가 아니에요. 스코어카드를 확인해 주세요.');
    }
  }

  const images = [];
  src.nines.forEach((n, i) => {
    const name = nines[i].name;
    n.holes.forEach((hole) => {
      for (const [kind, key, what] of [['hole', 'holeImageUrl', '홀 지도'], ['green', 'greenImageUrl', '그린 지도']]) {
        const url = typeof hole[key] === 'string' ? hole[key].trim() : '';
        if (url) images.push({ label: `${name} ${hole.number}번 ${what}`, fileName: `${name}_${hole.number}_${kind}.${urlExt(url)}`, url });
      }
    });
  });

  return {
    club,
    warnings,
    changes: existing ? changesOf(existing, club) : { removed: [], changed: [] },
    images,
    reference: referenceOf(json),
    notes: list(json.notes).map((x) => String(x)).filter((x) => x.trim()),
  };
}

function buildNine(n, old, label, tees, unit, warnings) {
  const holes = n.holes;
  const pars = holes.map((hole) => num(hole.par));
  const parSum = pars.reduce((s, v) => s + (v ?? 0), 0);
  if (pars.every((v) => v != null) && (parSum < 33 || parSum > 39)) warnings.push(`${label}: 파 합계가 ${parSum} 이에요(보통 35~37).`);

  const hcdps = holes.map((hole) => num(hole.hcdp));
  const filled = hcdps.filter((v) => v != null).length;
  if (filled > 0 && filled < m.NINE_HOLES) warnings.push(`${label}: HCDP 가 ${filled}개만 있어 비웠어요(9개 모두 있어야 넣어요).`);

  const rating = num(n.courseRating);
  const slope = num(n.slopeRating);
  const oldHoleAt = (k) => (old?.holes ?? []).find((x) => x.number === k) ?? null;

  const newHoles = holes.map((hole) => {
    const k = num(hole.number);
    const distances = {};
    const dist = hole.distances && typeof hole.distances === 'object' ? hole.distances : {};
    for (const [tee, value] of Object.entries(dist)) {
      if (!tees.includes(tee.trim())) {
        if (value != null) warnings.push(`${label} ${k}번 홀: "${tee}" 티는 티 목록(tees)에 없어 그 거리는 뺐어요.`);
        continue;
      }
      const v = num(value);
      if (v == null) {
        if (value != null) warnings.push(`${label} ${k}번 홀: ${tee} 거리 "${value}" 가 숫자가 아니라 뺐어요.`);
        continue;
      }
      distances[tee.trim()] = unit === 'yd' ? m.ydToM(v) : Math.round(v);
    }
    const prev = oldHoleAt(k);
    return {
      ...(prev ?? {}),
      number: k,
      distances,
      description: text(hole.description),
      hazards: list(hole.hazards).map(text).filter(Boolean),
      greenNote: text(hole.greenNote),
      myNote: prev?.myNote ?? null,
      holeImage: prev?.holeImage ?? null,
      greenImage: prev?.greenImage ?? null,
    };
  });

  const nine = {
    ...(old ?? {}),
    id: old?.id ?? m.newId(),
    name: old ? old.name : label,
    pars,
    strokeIndexes: filled === m.NINE_HOLES ? hcdps : null,
    courseRating: rating == null ? null : Math.round(rating * 10) / 10,
    slopeRating: slope == null ? null : Math.round(slope),
  };
  // 야디지북: 원래 있었거나 무언가 들어 있을 때만 holes 를 둔다
  if (Array.isArray(old?.holes) || newHoles.some(m.holeHasContent)) nine.holes = newHoles;
  else delete nine.holes;
  return nine;
}

/** 저장하지 않고 확인 화면에만 보여 줄 것: 지역, 웹 주소, 출처, 18홀 조합 레이팅. */
function referenceOf(json) {
  const c = json.club;
  const out = [];
  if (text(c.region)) out.push(`지역: ${c.region.trim()}`);
  if (text(c.website)) out.push(`공식 웹: ${c.website.trim()}`);
  const urls = list(json.source?.urls).filter((u) => typeof u === 'string' && u.trim());
  if (urls.length) out.push(`출처: ${urls.join(', ')}`);
  if (text(json.source?.checkedAt)) out.push(`확인한 날: ${json.source.checkedAt}`);
  for (const r of list(c.ratings)) {
    if (!r) continue;
    out.push(`레이팅 ${r.front ?? '?'}+${r.back ?? '?'} ${r.tee ?? ''}: ${r.courseRating ?? '–'} / 슬로프 ${r.slope ?? r.slopeRating ?? '–'}`);
  }
  return out;
}

// ── 바뀐 것 요약 ──

const filledText = (v) => (Array.isArray(v) ? v.length > 0 : v != null && String(v).trim() !== '');
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * 기존 골프장 → 새 골프장에서 바뀐 것. removed 는 기존 값이 빈 칸이 되는 것(따로 묶어 보여 준다).
 * 결과: { removed: string[], changed: string[] }
 */
export function changesOf(before, after) {
  const removed = [];
  const changed = [];
  const oldTees = before.tees ?? [];
  const newTees = after.tees ?? [];
  const addedTees = newTees.filter((t) => !oldTees.includes(t));
  const droppedTees = oldTees.filter((t) => !newTees.includes(t));
  if (addedTees.length) changed.push(`티 추가: ${addedTees.join(', ')}`);
  if (droppedTees.length) removed.push(`티 빠짐(그 티의 거리도 지워짐): ${droppedTees.join(', ')}`);
  if (!droppedTees.length && !addedTees.length && !same(oldTees, newTees)) changed.push(`티 순서: ${newTees.join(', ')}`);

  for (const nine of after.nines) {
    const old = before.nines.find((x) => x.id === nine.id);
    if (!old) {
      changed.push(`새 9홀 코스: ${nine.name}`);
      continue;
    }
    const name = nine.name;
    nine.pars.forEach((p, k) => {
      if (old.pars[k] !== p) changed.push(`${name} ${k + 1}번 홀 파 ${old.pars[k]}→${p ?? '빈 칸'}`);
    });
    if (!same(old.strokeIndexes, nine.strokeIndexes)) (nine.strokeIndexes ? changed : removed).push(`${name} HCDP`);
    for (const [key, what] of [['courseRating', '코스 레이팅'], ['slopeRating', '슬로프']]) {
      if (same(old[key], nine[key])) continue;
      if (nine[key] == null) removed.push(`${name} ${what}`);
      else changed.push(`${name} ${what} ${old[key] ?? '빈 칸'}→${nine[key]}`);
    }
    const oldHole = (k) => (old.holes ?? []).find((x) => x.number === k) ?? {};
    let distChanged = 0;
    const distRemoved = [];
    for (const hole of nine.holes ?? []) {
      const prev = oldHole(hole.number).distances ?? {};
      for (const tee of newTees) {
        if (same(prev[tee], hole.distances?.[tee])) continue;
        if (hole.distances?.[tee] == null) distRemoved.push(`${hole.number}번 ${tee}`);
        else distChanged++;
      }
    }
    if (distChanged) changed.push(`${name} 티별 거리 ${distChanged}칸`);
    if (distRemoved.length) removed.push(`${name} 거리: ${distRemoved.join(', ')}`);
    for (const [key, what] of [['description', '공략'], ['hazards', '위험 요소'], ['greenNote', '그린 메모']]) {
      const filledNow = [];
      const changedNow = [];
      const removedNow = [];
      for (let k = 1; k <= m.NINE_HOLES; k++) {
        const a = oldHole(k)[key];
        const b = (nine.holes ?? []).find((x) => x.number === k)?.[key];
        if (same(a, b) || (!filledText(a) && !filledText(b))) continue;
        if (!filledText(b)) removedNow.push(k);
        else if (!filledText(a)) filledNow.push(k);
        else changedNow.push(k);
      }
      const parts = [];
      if (filledNow.length) parts.push(`${filledNow.length}홀 채움`);
      if (changedNow.length) parts.push(`${changedNow.length}홀 바뀜`);
      if (parts.length) changed.push(`${name} ${what} ${parts.join(' · ')}`);
      if (removedNow.length) removed.push(`${name} ${what}: ${removedNow.map((k) => `${k}번`).join(', ')}`);
    }
  }
  return { removed, changed };
}

/** 그림 주소 목록 글([목록 복사]). */
export const imageListText = (images) => images.map((x) => `${x.label} → ${x.fileName} : ${x.url}`).join('\n');
