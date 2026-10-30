// 골프 스코어 웹 도구 화면. 계산은 model.js, 파일은 backup.js 가 하고 여기서는 보여 주고 고치기만 한다.
// 상태를 고칠 때마다 화면 전체를 다시 그린다(항목 수가 적어 충분히 빠르다). 포커스는 그린 뒤 되살린다.

import * as m from './model.js';
import {
  BackupError, buildSave, buildZip, changeCount, changesOf, deleteItem, openBackupBytes, saveFileName, saveProblems, undoDelete,
} from './backup.js';
import { clearDraft, loadDraft, saveDraft } from './draft.js';
import { prepareImage, imageUrl } from './images.js';
import { ImportError, buildClub, checkFormat, extractJson, findClub, imageListText } from './clubimport.js';
import { PROMPT } from './prompt.js';

const appEl = document.getElementById('app');
const tabsEl = document.getElementById('tabs');

/** 연 백업: { backup, originals } */
let state = null;
let fileName = null;
/** PC 크롬·엣지에서 파일을 열었을 때만. 연 파일에 덮어쓰기용. */
let fileHandle = null;
let draftInfo = null;

const view = {
  tab: 'clubs',
  club: null, // 고치는 중인 골프장(입력 상태)
  roundId: null,
  selected: new Set(),
  query: '',
  clubFilter: '',
  bulk: null, // { type: 'nines', clubId, key, replacePars } | { type: 'rename', name }
  assign: null, // 라운드 편집의 코스 지정 { clubId, key, replacePars }
  message: null, // { kind: 'ok'|'error'|'warn', text }
  fieldErrors: {},
  hole: null, // 골프장 편집에서 연 홀 상세 { nine: 코스 순서, k: 0~8 }
  importing: null, // AI 결과 붙여넣기 창 { text, error, json, targetId }
};

// ── 작은 도우미 ──

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const fmtDate = (ms) => m.isoDay(ms).replaceAll('-', '.');
const toParClass = (v) => (v < 0 ? 'under' : v > 0 ? 'over' : '');
const comboKey = (combo) => `${combo.front.id}|${combo.back?.id ?? ''}`;
const findCombo = (club, key) => m.startOptions(club).find((c) => comboKey(c) === key) ?? null;
const clubById = (id) => state.backup.clubs.find((c) => c.id === id) ?? null;
const roundById = (id) => state.backup.rounds.find((r) => r.id === id) ?? null;

function setRound(id, transform) {
  state.backup.rounds = state.backup.rounds.map((r) => (r.id === id ? transform(r) : r));
}

function isChangedRound(round) {
  return state.originals.rounds.get(round.id) !== JSON.stringify(round);
}

function bagName(clubId) {
  return state.backup.bag?.clubs?.find((c) => c.id === clubId)?.name ?? clubId ?? '채 없음';
}

// ── 그리기 ──

function render() {
  const active = document.activeElement;
  const focusId = active?.id;
  const caret = active && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  renderTabs();
  appEl.replaceChildren(...(state ? [messageBox(), screen()] : [startScreen()]));

  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      if (caret && 'setSelectionRange' in el) {
        try {
          el.setSelectionRange(...caret);
        } catch {
          // 숫자 칸 등은 커서를 못 옮긴다
        }
      }
    }
  }
}

function update(fn) {
  fn();
  scheduleDraft();
  render();
}

function renderTabs() {
  tabsEl.hidden = !state;
  if (!state) return;
  const count = changeCount(changesOf(state));
  const tab = (id, label) =>
    h('button', {
      'aria-current': view.tab === id ? 'page' : null,
      onclick: () => update(() => {
        view.tab = id;
        view.club = null;
        view.roundId = null;
        view.importing = null;
        view.message = null;
      }),
    }, label);
  tabsEl.replaceChildren(
    tab('clubs', '골프장'),
    tab('rounds', '라운드'),
    tab('save', count ? `저장 (${count})` : '저장'),
    h('button', { class: 'link', onclick: () => pickFile() }, '다른 파일 열기'),
  );
}

function messageBox() {
  if (!view.message) return h('div');
  return h('div', { class: `notice ${view.message.kind}` }, view.message.text);
}

function screen() {
  if (view.tab === 'clubs') return view.club ? clubEditor() : view.importing ? importScreen() : clubList();
  if (view.tab === 'rounds') return view.roundId ? roundEditor() : roundList();
  return saveScreen();
}

// ── 시작 ──

function startScreen() {
  const drop = h('div', { class: 'drop' },
    h('p', {}, h('strong', {}, '폰에서 내보낸 백업 파일(JSON 또는 그림 포함 zip)을 여세요')),
    h('p', { class: 'muted small' }, '폰 라운드 탭 ⋮ → 백업 파일로 저장. Google Drive 에 두면 PC·태블릿에서 바로 열 수 있어요.'),
    h('button', { class: 'primary', onclick: () => pickFile() }, '백업 파일 열기'),
    h('p', { class: 'muted small' }, '또는 파일을 여기에 끌어다 놓기'),
  );
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file, null);
  });

  return h('div', {},
    view.message ? messageBox() : null,
    draftInfo ? h('div', { class: 'card' },
      h('strong', {}, '작업 중인 내용이 있어요'),
      h('p', { class: 'muted small' }, `${draftInfo.fileName ?? '백업 파일'} · ${new Date(draftInfo.savedAt).toLocaleString('ko-KR')} 에 보관`),
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => resumeDraft() }, '이어서 하기'),
        h('button', { class: 'danger', onclick: async () => {
          await clearDraft();
          draftInfo = null;
          render();
        } }, '지우기'),
      ),
    ) : null,
    drop,
    h('div', { class: 'card' },
      h('h3', {}, '쓰는 순서'),
      h('ol', {},
        h('li', {}, '폰: 라운드 탭 ⋮ → 백업 파일로 저장 (JSON, 야디지북 그림이 있으면 그림 포함 zip)'),
        h('li', {}, '여기서 열고 골프장·야디지북·라운드를 고친 뒤 [저장] 탭에서 백업 파일로 저장'),
        h('li', {}, '폰: 라운드 탭 ⋮ → 백업 파일 가져오기 → 고친 것만 들어가요(지운 것은 폰이 물어본 뒤 지워요)'),
      ),
    ),
  );
}

async function pickFile() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: '골프 스코어 백업', accept: { 'application/json': ['.json'], 'application/zip': ['.zip'] } }],
      });
      loadFile(await handle.getFile(), handle);
    } catch (e) {
      if (e?.name !== 'AbortError') showError(`파일을 열지 못했어요: ${e.message}`);
    }
    return;
  }
  const input = h('input', { type: 'file', accept: '.json,.zip,application/json,application/zip' });
  input.addEventListener('change', () => {
    const file = input.files[0];
    if (file) loadFile(file, null);
  });
  input.click();
}

async function loadFile(file, handle) {
  if (state && hasChanges() && !confirm('지금 고친 내용을 저장하지 않고 다른 파일을 열까요?')) return;
  let next;
  try {
    next = await openBackupBytes(new Uint8Array(await file.arrayBuffer()));
  } catch (e) {
    state = null;
    showError(e instanceof BackupError ? e.message : `파일을 열지 못했어요: ${e.message}`);
    return;
  }
  state = next;
  fileName = file.name;
  fileHandle = handle;
  Object.assign(view, { tab: 'clubs', club: null, roundId: null, selected: new Set(), bulk: null, assign: null, fieldErrors: {}, hole: null, importing: null });
  const b = state.backup;
  view.message = {
    kind: 'ok',
    text: `${file.name} — 라운드 ${b.rounds.length}개 · 골프장 ${b.clubs.length}개 · 백업 ${fmtDate(b.exportedAt)}` +
      (state.fromZip ? ` · 야디지북 그림 ${state.images.size}개` : ''),
  };
  scheduleDraft();
  render();
}

function showError(text) {
  view.message = { kind: 'error', text };
  render();
}

const hasChanges = () => changeCount(changesOf(state)) > 0;

// ── 임시 보관 ──

let draftTimer = null;
function scheduleDraft() {
  if (!state) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    // 그림(Uint8Array)도 IndexedDB 에 그대로 넣는다(용량 때문에 localStorage 는 쓰지 않음).
    saveDraft({
      backupText: JSON.stringify(state.backup),
      originals: { rounds: [...state.originals.rounds], clubs: [...state.originals.clubs], deleted: [...(state.originals.deleted ?? [])] },
      images: [...state.images],
      changedImages: [...state.changedImages],
      trash: state.trash,
      fromZip: state.fromZip,
      fileName,
      savedAt: Date.now(),
    });
  }, 400);
}

async function resumeDraft() {
  const d = await loadDraft();
  if (!d) return;
  state = {
    backup: JSON.parse(d.backupText),
    originals: { rounds: new Map(d.originals.rounds), clubs: new Map(d.originals.clubs), deleted: new Set(d.originals.deleted ?? []) },
    images: new Map(d.images ?? []),
    changedImages: new Set(d.changedImages ?? []),
    trash: d.trash ?? [],
    fromZip: !!d.fromZip,
  };
  if (!Array.isArray(state.backup.deleted)) state.backup.deleted = [];
  fileName = d.fileName;
  fileHandle = null;
  view.message = { kind: 'ok', text: `이어서 합니다 — ${fileName ?? '백업 파일'}` };
  render();
}

// ── 골프장 ──

function clubList() {
  const clubs = state.backup.clubs;
  return h('div', {},
    h('div', { class: 'row' },
      h('h2', {}, `골프장 ${clubs.length}개`),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => copyText(PROMPT, 'AI 프롬프트를 복사했어요. {골프장 이름} 과 자료를 채워 ChatGPT·Claude 에 붙여 넣으세요.') }, '프롬프트 복사'),
      h('button', { onclick: () => update(() => (view.importing = { text: '', error: null, json: null, targetId: '' })) }, 'AI 결과 붙여넣기'),
      h('button', { class: 'primary', onclick: () => update(() => (view.club = clubInput(null))) }, '+ 골프장 추가'),
    ),
    clubs.length === 0 ? h('p', { class: 'muted' }, '저장한 골프장이 없어요.') : null,
    clubs.map((club) => {
      const rounds = state.backup.rounds.filter((r) => r.courseId === club.id).length;
      const changed = state.originals.clubs.get(club.id) !== JSON.stringify(club);
      return h('div', { class: 'card' },
        h('div', { class: 'row' },
          h('strong', {}, club.name),
          !state.originals.clubs.has(club.id) ? h('span', { class: 'badge' }, '새로 만듦') : changed ? h('span', { class: 'badge warn' }, '고침') : null,
          h('span', { class: 'spacer' }),
          h('button', { onclick: () => update(() => {
            view.club = clubInput(club);
            view.hole = null;
          }) }, '고치기'),
          h('button', { class: 'link danger-text', onclick: () => {
            const msg = rounds > 0
              ? `${club.name} 을(를) 지울까요? 이 골프장으로 친 라운드 ${rounds}개는 남고 골프장 연결만 끊겨요. 폰은 가져올 때 한 번 더 물어봐요.`
              : `${club.name} 을(를) 지울까요? 폰은 가져올 때 한 번 더 물어봐요.`;
            if (!confirm(msg)) return;
            update(() => {
              deleteItem(state, 'club', club.id);
              view.message = { kind: 'ok', text: `${club.name} 을(를) 지웠어요. [저장] 탭에서 되돌릴 수 있어요.` };
            });
          } }, '지우기'),
        ),
        h('div', { class: 'muted small' }, `9홀 코스 ${club.nines.length}개 · ${club.nines.map((n) => n.name).join('·')} · 이 골프장으로 친 라운드 ${rounds}개`,
          club.tees?.length ? ` · 티 ${club.tees.join('·')}` : ''),
        club.nines.map((n) => h('div', { class: 'small' },
          `${n.name}  파 ${n.pars.join(' ')} (${n.pars.reduce((a, b) => a + b, 0)})`,
          n.strokeIndexes ? `  · HCDP ${n.strokeIndexes.join(' ')}` : '',
          n.courseRating != null || n.slopeRating != null ? `  · 레이팅 ${n.courseRating ?? '–'} / 슬로프 ${n.slopeRating ?? '–'}` : '',
          m.nineHasYardage(n) ? `  · 📖 야디지북 ${n.holes.filter(m.holeHasContent).length}홀` : '',
        )),
      );
    }),
  );
}

/**
 * 골프장 편집 입력 상태. 9홀 코스마다 홀별 칸(파 9칸, HCDP 9칸, 티마다 거리 9칸)과 9홀 레이팅·슬로프 글자,
 * 홀마다 야디지북 글·그림(infos)을 둔다. 모르는 필드는 rest 에 그대로 둔다(저장할 때 다시 씀).
 * 티는 행마다 key 를 붙여 이름을 바꿔도 거리 칸이 따라가게 한다. 거리 칸은 input.yards 면 야드로 보여 준다.
 * 새로 넣은 그림은 골프장을 저장할 때까지 input.pendingImages 에 둔다.
 */
let teeSeq = 0;
const newTeeKey = () => `t${++teeSeq}`;

function holeInfoInput(hole, number) {
  const x = hole ?? {};
  return {
    rest: hole ?? { number },
    description: x.description ?? '',
    hazardsText: (x.hazards ?? []).join(', '),
    greenNote: x.greenNote ?? '',
    myNote: x.myNote ?? '',
    holeImage: x.holeImage ?? null,
    greenImage: x.greenImage ?? null,
  };
}

function nineInputOf(n, tees) {
  const holeAt = (k) => (n.holes ?? []).find((x) => x.number === k + 1) ?? null;
  const dists = {};
  for (const tee of tees) dists[tee.key] = [...Array(9)].map((_, k) => String(holeAt(k)?.distances?.[tee.name] ?? ''));
  return {
    rest: n, id: n.id, isNew: false, name: n.name,
    pars: n.pars.map((v) => (v == null ? '' : String(v))),
    sis: n.strokeIndexes ? n.strokeIndexes.map(String) : Array(9).fill(''),
    ratingText: n.courseRating != null ? String(n.courseRating) : '',
    slopeText: n.slopeRating != null ? String(n.slopeRating) : '',
    dists,
    infos: [...Array(9)].map((_, k) => holeInfoInput(holeAt(k), k + 1)),
    hadHoles: Array.isArray(n.holes),
  };
}

function freshNineInput(name, pars, tees = []) {
  const dists = {};
  for (const tee of tees) dists[tee.key] = Array(9).fill('');
  return {
    rest: {}, id: m.newId(), isNew: true, name, pars: pars.map(String), sis: Array(9).fill(''), ratingText: '', slopeText: '',
    dists, infos: [...Array(9)].map((_, k) => holeInfoInput(null, k + 1)), hadHoles: false,
  };
}

function clubInput(club) {
  if (!club) {
    return {
      rest: {}, id: m.newId(), isNew: true, name: '', updatedAt: 0, tees: [], hadTees: false, yards: false, pendingImages: new Map(),
      nines: [freshNineInput('OUT', m.DEFAULT_PARS_18.slice(0, 9)), freshNineInput('IN', m.DEFAULT_PARS_18.slice(9))],
    };
  }
  const tees = (club.tees ?? []).map((name) => ({ key: newTeeKey(), name }));
  return {
    rest: club, id: club.id, isNew: false, name: club.name, updatedAt: club.updatedAt,
    tees, hadTees: Array.isArray(club.tees), yards: false, pendingImages: new Map(),
    nines: club.nines.map((n) => nineInputOf(n, tees)),
  };
}

const parCellOk = (v) => /^\d+$/.test(v.trim()) && Number(v) >= 3 && Number(v) <= 6;
const distCellBad = (v, yards) => Number.isNaN(m.parseDistance(v, yards));

/** HCDP 칸 하나가 틀렸는지: 1~18 정수이고 같은 코스에서 겹치지 않아야 한다. 빈 칸은 여기서 보지 않는다. */
function siCellBad(sis, i) {
  const v = sis[i].trim();
  if (v === '') return false;
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 18) return true;
  return sis.some((other, j) => j !== i && other.trim() !== '' && Number(other) === Number(v));
}

/** 9홀 코스 입력의 문제(칸 단위 검사). 저장을 막는다. */
function nineInputProblems(n, input) {
  const problems = [];
  const label = n.name.trim() || '코스';
  if (!n.name.trim()) problems.push('코스 이름이 비어 있어요');
  if (n.pars.some((v) => !parCellOk(v))) problems.push(`${label}: 파는 3~6 숫자로 적어 주세요`);
  const filled = n.sis.filter((v) => v.trim() !== '').length;
  if (filled > 0 && filled < 9) problems.push(`${label}: HCDP 는 9칸 모두 채우거나 모두 비워 주세요`);
  if (n.sis.some((_, i) => siCellBad(n.sis, i))) problems.push(`${label}: HCDP 는 1~18, 서로 다른 숫자로 적어 주세요`);
  if (n.ratingText.trim() && m.parseNineRating(n.ratingText) == null) problems.push(`${label}: 코스 레이팅은 ${m.NINE_RATING[0]}~${m.NINE_RATING[1]} (9홀 값)`);
  if (n.slopeText.trim() && m.parseSlope(n.slopeText) == null) problems.push(`${label}: 슬로프는 55~155`);
  if (input.tees.some((t) => (n.dists[t.key] ?? []).some((v) => distCellBad(v, input.yards)))) {
    problems.push(`${label}: 거리는 ${m.DISTANCE_RANGE[0]}~${m.DISTANCE_RANGE[1]}m 정수로 적어 주세요`);
  }
  return problems;
}

function clubInputProblems(input) {
  const problems = [...(input.name.trim() ? [] : ['골프장 이름이 비어 있어요']), ...input.nines.flatMap((n) => nineInputProblems(n, input))];
  const names = input.tees.map((t) => t.name.trim());
  if (names.some((x) => !x)) problems.push('티 이름이 비어 있어요');
  if (new Set(names).size !== names.length) problems.push('티 이름이 겹쳐요');
  return problems;
}

function holesFromInput(n, input) {
  const holes = n.infos.map((info, k) => {
    const distances = {};
    for (const tee of input.tees) {
      const v = m.parseDistance(n.dists[tee.key]?.[k], input.yards);
      if (Number.isFinite(v) && tee.name.trim()) distances[tee.name.trim()] = v;
    }
    const text = (s) => (s.trim() ? s.trim() : null);
    return {
      ...info.rest,
      number: k + 1,
      distances,
      description: text(info.description),
      hazards: m.parseHazards(info.hazardsText),
      greenNote: text(info.greenNote),
      myNote: text(info.myNote),
      holeImage: info.holeImage,
      greenImage: info.greenImage,
    };
  });
  return holes;
}

function clubFromInput(input) {
  const tees = input.tees.map((t) => t.name.trim()).filter(Boolean);
  const club = {
    ...input.rest,
    id: input.id,
    name: input.name.trim(),
    nines: input.nines.map((n) => {
      const allSi = n.sis.every((v) => v.trim() !== '');
      const nine = {
        ...n.rest,
        id: n.id,
        name: n.name.trim(),
        pars: n.pars.map((v) => (parCellOk(v) ? Number(v) : 4)),
        strokeIndexes: allSi ? n.sis.map(Number) : null,
        courseRating: m.parseNineRating(n.ratingText),
        slopeRating: m.parseSlope(n.slopeText),
      };
      // 야디지북: 원래 있었거나 무언가 적었을 때만 holes 를 둔다(없던 코스에 빈 holes 를 만들면 고친 것으로 보이므로)
      const holes = holesFromInput(n, input);
      if (n.hadHoles || holes.some(m.holeHasContent)) nine.holes = holes;
      else delete nine.holes;
      return nine;
    }),
    updatedAt: input.updatedAt,
  };
  if (input.hadTees || tees.length) club.tees = tees;
  else delete club.tees;
  return club;
}

/** 엔터를 누르면 갈 칸: 파 1→9 → HCDP 1→9 → 티 거리 행들 → 다음 코스 파 1(마지막 코스면 그 코스 레이팅). */
function nextCellId(i, row, col, input) {
  if (col < 8) return `n${i}-${row}-${col + 1}`;
  const rows = ['p', 's', ...input.tees.map((t) => `d${t.key}`)];
  const r = rows.indexOf(row);
  if (r >= 0 && r + 1 < rows.length) return `n${i}-${rows[r + 1]}-0`;
  return i + 1 < input.nines.length ? `n${i + 1}-p-0` : `n${i}-cr`;
}

/** 9홀 코스 하나의 가로 표(스코어카드 모양): 파, HCDP, 티마다 거리. */
function nineGrid(input, n, i) {
  const unit = input.yards ? 'yd' : 'm';
  const cell = (row, col, values, bad, label) => h('td', {}, h('input', {
    id: `n${i}-${row}-${col}`, value: values[col], inputmode: 'numeric', maxlength: row.startsWith('d') ? 3 : 2, autocomplete: 'off',
    class: row.startsWith('d') ? 'dist' : null,
    'aria-label': `${m.ordinalCourse(i)} ${col + 1}번 홀 ${label}`,
    'aria-invalid': bad ? 'true' : null,
    oninput: (e) => (values[col] = e.target.value),
    onchange: () => render(),
    onfocus: (e) => e.target.select(),
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      values[col] = e.target.value;
      render();
      const next = document.getElementById(nextCellId(i, row, col, input));
      next?.focus();
      next?.select?.();
    },
    // "4,4,3,5…" 처럼 여러 숫자를 붙여 넣으면 이 칸부터 오른쪽으로 나눠 채운다
    onpaste: (e) => {
      const nums = m.splitNumbers(e.clipboardData.getData('text'));
      if (nums.length < 2) return;
      e.preventDefault();
      nums.slice(0, 9 - col).forEach((v, k) => (values[col + k] = v));
      render();
    },
  }));
  const total = n.pars.reduce((s, v) => s + (parCellOk(v) ? Number(v) : 0), 0);
  const distRows = input.tees.map((tee) => {
    const values = n.dists[tee.key] ?? (n.dists[tee.key] = Array(9).fill(''));
    const sum = values.reduce((s, v) => s + (/^\d+$/.test(v.trim()) ? Number(v) : 0), 0);
    return h('tr', {}, h('th', {}, `${tee.name || '티'} (${unit})`),
      [...Array(9)].map((_, k) => cell(`d${tee.key}`, k, values, distCellBad(values[k], input.yards), `${tee.name} 거리`)),
      h('td', { class: 'num muted' }, sum || ''));
  });
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'nine-grid' },
      h('thead', {}, h('tr', {}, h('th', {}, '홀'), [...Array(9)].map((_, k) => h('th', { class: 'num' }, k + 1)), h('th', { class: 'num' }, '합계'))),
      h('tbody', {},
        h('tr', {}, h('th', {}, '파'), [...Array(9)].map((_, k) => cell('p', k, n.pars, !parCellOk(n.pars[k]), '파')), h('td', { class: 'num' }, h('strong', {}, total))),
        h('tr', {}, h('th', {}, 'HCDP'), [...Array(9)].map((_, k) => cell('s', k, n.sis, siCellBad(n.sis, k), 'HCDP')), h('td', {})),
        distRows,
      ),
    ),
  );
}

/** 티 목록 편집: 이름 칸, 순서 바꾸기, 지우기, 추가. 거리 칸은 key 로 따라간다. */
function teesEditor(input) {
  const move = (k, d) => {
    const t = input.tees.splice(k, 1)[0];
    input.tees.splice(k + d, 0, t);
    render();
  };
  return h('div', { class: 'tees' },
    h('div', { class: 'row' },
      h('strong', {}, '티 (야디지북 거리)'),
      h('label', { class: 'row small' },
        h('input', { type: 'checkbox', checked: input.yards, onchange: (e) => toggleYards(input, e.target.checked) }),
        '거리를 야드로 적기 (저장할 때 미터로 바꿈)'),
    ),
    input.tees.length === 0 ? h('div', { class: 'row' },
      h('span', { class: 'muted small' }, '티를 넣으면 9홀 코스 표에 티별 거리 줄이 생겨요.'),
      h('button', { onclick: () => {
        input.tees = m.DEFAULT_TEES.map((name) => ({ key: newTeeKey(), name }));
        render();
      } }, `기본 티 넣기 (${m.DEFAULT_TEES.join('·')})`),
    ) : null,
    h('div', { class: 'chips' }, input.tees.map((tee, k) => h('span', { class: 'tee' },
      h('input', { id: `tee-${tee.key}`, value: tee.name, size: 6, 'aria-label': `${k + 1}번째 티 이름`,
        'aria-invalid': !tee.name.trim() ? 'true' : null,
        onchange: (e) => {
          tee.name = e.target.value;
          render();
        } }),
      k > 0 ? h('button', { class: 'link', title: '앞으로', onclick: () => move(k, -1) }, '◀') : null,
      k < input.tees.length - 1 ? h('button', { class: 'link', title: '뒤로', onclick: () => move(k, 1) }, '▶') : null,
      h('button', { class: 'link', title: '지우기', onclick: () => {
        const filled = input.nines.some((n) => (n.dists[tee.key] ?? []).some((v) => v.trim()));
        if (filled && !confirm(`${tee.name} 티의 거리를 모두 지울까요?`)) return;
        input.tees.splice(k, 1);
        render();
      } }, '✕'),
    ))),
    h('button', { class: 'link', onclick: () => {
      const tee = { key: newTeeKey(), name: '' };
      input.tees.push(tee);
      render();
      document.getElementById(`tee-${tee.key}`)?.focus();
    } }, '+ 티 추가'),
  );
}

/** 야드로 적기를 켜고 끌 때 칸의 숫자를 바꿔 보여 준다(미터 ↔ 야드는 정수로 오가도 같은 값으로 돌아온다). */
function toggleYards(input, yards) {
  if (input.yards === yards) return;
  const convert = yards ? m.mToYd : m.ydToM;
  for (const n of input.nines) {
    for (const key of Object.keys(n.dists)) {
      n.dists[key] = n.dists[key].map((v) => (/^\d+$/.test(v.trim()) ? String(convert(Number(v))) : v));
    }
  }
  input.yards = yards;
  render();
}

/** 그림 바이트: 이번 편집에서 넣은 것 → 파일에 있던 것. 없으면 null(폰에만 있음). */
const imageBytes = (input, name) => (name ? input.pendingImages.get(name) ?? state.images.get(name) ?? null : null);

/** 그림 한 장 넣기: 줄여서(1600px 보다 클 때만) 이 홀의 이름으로 둔다. */
async function putImage(input, n, k, kind, file) {
  try {
    const bytes = await prepareImage(file);
    const name = m.imageName(n.id, k + 1, kind);
    input.pendingImages.set(name, bytes);
    n.infos[k][kind === 'hole' ? 'holeImage' : 'greenImage'] = name;
    return true;
  } catch (e) {
    showError(`그림을 넣지 못했어요(${file.name ?? '붙여 넣은 그림'}): ${e.message}`);
    return false;
  }
}

/** 그림 칸: 그림 보기, 끌어다 놓기, 붙여넣기(칸을 누르고 Ctrl+V), 파일 고르기, 지우기. */
function imageSlot(input, n, k, kind) {
  const key = kind === 'hole' ? 'holeImage' : 'greenImage';
  const name = n.infos[k][key];
  const bytes = imageBytes(input, name);
  const label = kind === 'hole' ? '홀 지도' : '그린 지도';
  const pick = () => {
    const fileInput = h('input', { type: 'file', accept: 'image/*' });
    fileInput.addEventListener('change', async () => {
      if (fileInput.files[0] && (await putImage(input, n, k, kind, fileInput.files[0]))) render();
    });
    fileInput.click();
  };
  const slot = h('div', { class: 'image-slot', tabindex: '0', 'aria-label': `${label}: 끌어다 놓기, 붙여넣기, 눌러서 파일 고르기` },
    h('div', { class: 'small' }, h('strong', {}, label)),
    bytes ? h('img', { src: imageUrl(bytes), alt: label })
      : name ? h('p', { class: 'muted small' }, '그림이 폰에 있어요(이 파일에는 없음). 그림 포함 zip 으로 열면 보여요.')
        : h('p', { class: 'muted small' }, '끌어다 놓기 · 이 칸을 누르고 Ctrl+V · ', h('button', { class: 'link', onclick: pick }, '파일 고르기')),
    name ? h('div', { class: 'row' },
      h('button', { class: 'link', onclick: pick }, '바꾸기'),
      h('button', { class: 'link', onclick: () => {
        n.infos[k][key] = null;
        render();
      } }, '지우기'),
    ) : null,
  );
  slot.addEventListener('dragover', (e) => {
    e.preventDefault();
    slot.classList.add('over');
  });
  slot.addEventListener('dragleave', () => slot.classList.remove('over'));
  slot.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    slot.classList.remove('over');
    const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('image/'));
    if (file && (await putImage(input, n, k, kind, file))) render();
  });
  slot.addEventListener('paste', async (e) => {
    const item = [...e.clipboardData.items].find((x) => x.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    if (await putImage(input, n, k, kind, item.getAsFile())) render();
  });
  return slot;
}

/** 홀 상세(야디지북): 그림 두 칸과 글. */
function holePanel(input, n, i, k) {
  const info = n.infos[k];
  const field = (label, prop, multiline, placeholder) => h('label', { class: 'field' }, label,
    h(multiline ? 'textarea' : 'input', {
      id: `n${i}-h${k}-${prop}`, value: info[prop], placeholder,
      onchange: (e) => {
        info[prop] = e.target.value;
        render();
      },
    }, multiline ? info[prop] : null));
  const go = (d) => update(() => {
    let { nine, k: hole } = view.hole;
    hole += d;
    if (hole > 8 && nine + 1 < input.nines.length) [nine, hole] = [nine + 1, 0];
    if (hole < 0 && nine > 0) [nine, hole] = [nine - 1, 8];
    if (hole >= 0 && hole <= 8) view.hole = { nine, k: hole };
  });
  return h('div', { class: 'hole-panel' },
    h('div', { class: 'row' },
      h('strong', {}, `${n.name || m.ordinalCourse(i)} ${k + 1}번 홀 · 파 ${n.pars[k]}${n.sis[k].trim() ? ` · HCDP ${n.sis[k]}` : ''}`),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => go(-1) }, '◀ 이전 홀'),
      h('button', { onclick: () => go(1) }, '다음 홀 ▶'),
      h('button', { class: 'link', onclick: () => update(() => (view.hole = null)) }, '닫기'),
    ),
    h('div', { class: 'grid2' }, imageSlot(input, n, k, 'hole'), imageSlot(input, n, k, 'green')),
    field('공식 공략 (홈페이지 요약)', 'description', true, '티샷은 페어웨이 오른쪽을 겨냥…'),
    h('div', { class: 'grid2' },
      field('위험 요소 (쉼표로 구분)', 'hazardsText', false, '왼쪽 OB, 그린 앞 벙커'),
      field('그린 메모', 'greenNote', false, '투그린, 앞뒤로 긴 그린'),
    ),
    field('내 공략 메모', 'myNote', true, '드라이버 대신 3W'),
  );
}

/** 9홀 코스 아래 홀 버튼(야디지북이 있는 홀은 ●). 누르면 그 홀 상세를 연다. */
function holeButtons(input, n, i) {
  const club = clubFromInput(input);
  const nine = club.nines[i];
  return h('div', { class: 'row small' },
    h('span', { class: 'muted' }, '야디지북 홀:'),
    [...Array(9)].map((_, k) => {
      const open = view.hole?.nine === i && view.hole?.k === k;
      const filled = m.holeHasContent(nine.holes?.[k]);
      return h('button', { class: 'chip', 'aria-pressed': String(open), onclick: () => update(() => (view.hole = open ? null : { nine: i, k })) },
        `${k + 1}${filled ? '●' : ''}`);
    }),
  );
}

/** 여러 그림을 파일 이름 규칙(코스이름_홀번호_hole.jpg)으로 한꺼번에 넣는다. */
async function dropManyImages(input, files) {
  const unmatched = [];
  let added = 0;
  for (const file of files) {
    const parsed = m.parseImageFileName(file.name);
    const index = parsed ? input.nines.findIndex((n) => n.name.trim().toLowerCase() === parsed.course.toLowerCase()) : -1;
    if (index < 0) {
      unmatched.push(file.name);
      continue;
    }
    if (await putImage(input, input.nines[index], parsed.number - 1, parsed.kind, file)) added++;
  }
  view.message = unmatched.length
    ? { kind: 'warn', text: `그림 ${added}장을 넣었어요. 이름 규칙(코스이름_홀번호_hole.jpg / _green.jpg)에 맞지 않거나 코스 이름이 없는 파일: ${unmatched.join(', ')}` }
    : { kind: 'ok', text: `그림 ${added}장을 넣었어요. 골프장을 저장하세요.` };
  render();
}

function clubEditor() {
  const input = view.club;
  const club = clubFromInput(input);
  const problems = clubInputProblems(input);
  const changeAndRender = (fn) => (e) => {
    fn(e.target);
    render();
  };
  const bulkDrop = h('div', { class: 'drop small' },
    h('strong', {}, '그림 여러 장 한꺼번에: '),
    `파일 이름을 "코스이름_홀번호_hole.jpg" / "코스이름_홀번호_green.jpg" 로 저장해 두고 여기에 끌어다 놓으세요. 1600px 보다 크면 줄여요.`);
  bulkDrop.addEventListener('dragover', (e) => {
    e.preventDefault();
    bulkDrop.classList.add('over');
  });
  bulkDrop.addEventListener('dragleave', () => bulkDrop.classList.remove('over'));
  bulkDrop.addEventListener('drop', (e) => {
    e.preventDefault();
    bulkDrop.classList.remove('over');
    dropManyImages(input, [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
  });

  return h('div', {},
    h('div', { class: 'row' },
      h('button', { onclick: () => update(() => {
        view.club = null;
        view.hole = null;
      }) }, '← 목록'),
      h('h2', {}, input.isNew ? '골프장 추가' : '골프장 고치기'),
    ),
    input.imported ? importBox(input.imported) : null,
    h('div', { class: 'card' },
      h('label', { class: 'field' }, '골프장 이름',
        h('input', { id: 'club-name', value: input.name, onchange: changeAndRender((t) => (input.name = t.value)) })),
      teesEditor(input),
      h('p', { class: 'muted small' },
        '9홀 코스마다 홀별 파·HCDP·티별 거리를 칸에 적어요. 엔터를 누르면 다음 홀로 넘어가요. ',
        '"4,4,3,5…" 를 한 칸에 붙여 넣으면 오른쪽 칸으로 나눠 채워요. HCDP 는 9칸 모두 적거나 모두 비워 두세요. ',
        '홀 번호 버튼을 누르면 그 홀의 그림·공략을 넣어요. 27·36홀 골프장은 [9홀 코스 추가] 로 더해요.'),
      input.nines.map((n, i) => h('div', { class: 'nine' },
        h('div', { class: 'nine-head' },
          h('strong', {}, m.ordinalCourse(i)),
          h('input', { id: `n${i}-name`, value: n.name, placeholder: '코스 이름 (OUT, IN, 크리크…)', 'aria-label': '코스 이름',
            'aria-invalid': !n.name.trim() ? 'true' : null, onchange: changeAndRender((t) => (n.name = t.value)) }),
          input.nines.length > 1 ? h('button', { class: 'link', onclick: () => removeNine(input, i) }, '삭제') : null,
        ),
        nineGrid(input, n, i),
        h('div', { class: 'row' },
          h('label', { class: 'field' }, `코스 레이팅 (9홀, ${m.NINE_RATING[0]}~${m.NINE_RATING[1]})`,
            h('input', { id: `n${i}-cr`, value: n.ratingText, inputmode: 'decimal', placeholder: '35.6',
              'aria-invalid': n.ratingText.trim() && m.parseNineRating(n.ratingText) == null ? 'true' : null,
              onchange: changeAndRender((t) => (n.ratingText = t.value)) })),
          h('label', { class: 'field' }, '슬로프 (9홀, 55~155)',
            h('input', { id: `n${i}-sl`, value: n.slopeText, inputmode: 'numeric', placeholder: '127',
              'aria-invalid': n.slopeText.trim() && m.parseSlope(n.slopeText) == null ? 'true' : null,
              onchange: changeAndRender((t) => (n.slopeText = t.value)) })),
        ),
        holeButtons(input, n, i),
        view.hole?.nine === i ? holePanel(input, n, i, view.hole.k) : null,
      )),
      h('button', { onclick: () => {
        input.nines.push(freshNineInput('', Array(9).fill(4), input.tees));
        render();
        document.getElementById(`n${input.nines.length - 1}-name`)?.focus();
      } }, '+ 9홀 코스 추가'),
      bulkDrop,
      problems.length ? h('ul', { class: 'problems' }, problems.map((p) => h('li', {}, p))) : null,
      club.nines.length >= 2 && club.nines.every((x) => x.courseRating != null && x.slopeRating != null)
        ? h('p', { class: 'muted small' }, `18홀 예: ${club.nines[0].name}+${club.nines[1].name} = 레이팅 ${m.comboRatings({ front: club.nines[0], back: club.nines[1] }).courseRating} / 슬로프 ${m.comboRatings({ front: club.nines[0], back: club.nines[1] }).slopeRating} (합·평균)`)
        : null,
    ),
    h('div', { class: 'sticky-actions' },
      h('button', { class: 'primary', disabled: problems.length > 0, onclick: () => saveClub(input) }, '골프장 저장'),
      h('button', { onclick: () => {
        if (input.pendingImages.size && !confirm('넣은 그림을 저장하지 않고 닫을까요?')) return;
        update(() => {
          view.club = null;
          view.hole = null;
        });
      } }, '취소'),
    ),
  );
}

// ── AI 결과 붙여넣기 (앱 저장소 docs/spec-club-import.md) ──

async function copyText(text, okText) {
  try {
    await navigator.clipboard.writeText(text);
    view.message = { kind: 'ok', text: okText };
  } catch (e) {
    view.message = { kind: 'error', text: `복사하지 못했어요: ${e.message}` };
  }
  render();
}

/** 붙여 넣은 글을 읽어 형식을 검사하고, 같은 이름의 골프장을 고른다. */
function readImport(imp) {
  try {
    imp.json = checkFormat(extractJson(imp.text));
    imp.error = null;
    imp.targetId = findClub(state.backup.clubs, imp.json.club.name)?.id ?? '';
  } catch (e) {
    imp.json = null;
    imp.error = e instanceof ImportError ? e.message : `읽지 못했어요: ${e.message}`;
  }
}

function importScreen() {
  const imp = view.importing;
  const loadJsonFile = async (file) => {
    imp.text = await file.text();
    readImport(imp);
    render();
  };
  const drop = h('div', { class: 'drop small' }, 'club.json 파일을 여기에 끌어다 놓아도 돼요.');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const file = e.dataTransfer.files[0];
    if (file) loadJsonFile(file);
  });
  const json = imp.json;
  return h('div', {},
    h('div', { class: 'row' },
      h('button', { onclick: () => update(() => (view.importing = null)) }, '← 목록'),
      h('h2', {}, 'AI 결과 붙여넣기'),
    ),
    h('div', { class: 'card' },
      h('p', { class: 'muted small' },
        '[프롬프트 복사] 로 받은 프롬프트에 골프장 자료를 붙여 AI(ChatGPT·Claude)에 물어본 뒤, AI 답을 그대로 붙여 넣으세요. ',
        '앞뒤 설명 문장이 있어도 JSON 부분만 읽어요.'),
      h('textarea', { id: 'import-text', class: 'import-text', value: imp.text, placeholder: '{ "format": "golfscore-club/1", … }',
        'aria-label': 'AI 결과', oninput: (e) => (imp.text = e.target.value) }, imp.text),
      drop,
      h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => update(() => readImport(imp)) }, '읽기'),
      ),
      imp.error ? h('p', { class: 'notice error' }, imp.error) : null,
    ),
    json ? h('div', { class: 'card' },
      h('strong', {}, json.club.name || '(이름 없음)'),
      h('div', { class: 'muted small' },
        `9홀 코스 ${json.club.nines.length}개 · ${json.club.nines.map((n) => n.name).join('·')}`,
        json.club.tees?.length ? ` · 티 ${json.club.tees.join('·')}` : '',
        json.club.distanceUnit ? ` · 거리 ${json.club.distanceUnit}` : ''),
      h('label', { class: 'field' }, '넣을 곳',
        h('select', { id: 'import-target', onchange: (e) => update(() => (imp.targetId = e.target.value)) },
          h('option', { value: '' }, '새 골프장으로 추가'),
          state.backup.clubs.map((c) => h('option', { value: c.id, selected: imp.targetId === c.id }, `${c.name} 에 넣기`)),
        )),
      imp.targetId ? h('p', { class: 'notice' },
        'AI 결과에 있는 9홀 코스(이름이 같은 코스)는 AI 결과로 통째로 바뀌어요. AI 가 못 찾은 칸은 비워져요. ',
        '골프장 이름·내 공략 메모·그림·AI 결과에 없는 9홀 코스는 그대로예요. 저장 전에 편집 화면에서 확인해요.') : null,
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => openImport(imp) }, '편집 화면 열기')),
    ) : null,
  );
}

function openImport(imp) {
  const existing = imp.targetId ? clubById(imp.targetId) : null;
  const result = buildClub(imp.json, existing);
  const input = clubInput(result.club);
  input.isNew = !existing;
  input.imported = result;
  update(() => {
    view.club = input;
    view.importing = null;
    view.hole = null;
    view.message = null;
  });
}

/** 편집 화면 맨 위: AI 메모, 경고, 지워지는 값, 바뀐 것, 참고 정보, 그림 주소 목록. 저장하면 사라진다. */
function importBox(info) {
  const section = (title, items, cls) => (items.length
    ? h('div', { class: cls ?? null }, h('strong', { class: 'small' }, title), h('ul', { class: 'small' }, items.map((x) => h('li', {}, x))))
    : null);
  const { removed, changed } = info.changes;
  return h('div', { class: 'card import-box' },
    h('div', { class: 'row' },
      h('strong', {}, 'AI 결과를 채웠어요 — 아직 저장 안 됨'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'link', onclick: () => {
        view.club.imported = null;
        render();
      } }, '이 상자 닫기'),
    ),
    h('p', { class: 'muted small' }, '칸을 확인하고 고친 뒤 맨 아래 [골프장 저장] 을 누르세요. [취소] 하면 아무것도 바뀌지 않아요.'),
    section('AI 메모', info.notes),
    section('확인할 것', info.warnings, 'warn-text'),
    removed.length ? h('div', { class: 'error-text' },
      h('strong', { class: 'small' }, `지워지는 값 ${removed.length}개`),
      h('span', { class: 'small' }, ' — 남기려면 저장 전에 아래 칸에 다시 적으세요'),
      h('ul', { class: 'small' }, removed.map((x) => h('li', {}, x)))) : null,
    changed.length ? h('details', {}, h('summary', { class: 'small' }, `바뀐 것 ${changed.length}개`),
      h('ul', { class: 'small' }, changed.map((x) => h('li', {}, x)))) : null,
    section('참고 (저장하지 않음)', info.reference, 'muted'),
    info.images.length ? h('details', {},
      h('summary', { class: 'small' }, `그림 주소 ${info.images.length}개 — 이 이름으로 저장해 아래 [그림 여러 장 한꺼번에] 칸에 끌어다 놓으세요`),
      h('button', { onclick: () => copyText(imageListText(info.images), `그림 주소 ${info.images.length}개를 복사했어요.`) }, '목록 복사'),
      h('ul', { class: 'small' }, info.images.map((x) => h('li', {}, `${x.label} → `, h('code', {}, x.fileName), ' ',
        h('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, '열기'))))) : null,
  );
}

function removeNine(input, index) {
  const nine = input.nines[index];
  if (!nine.isNew) {
    const n = m.roundsUsingNine(state.backup.rounds, input.id, nine.id);
    if (n > 0 && !confirm(`${nine.name} 코스로 친 라운드 ${n}개의 코스 연결이 끊깁니다(라운드 기록은 남아요). 삭제할까요?`)) return;
  }
  input.nines.splice(index, 1);
  view.hole = null;
  render();
}

function saveClub(input) {
  const club = clubFromInput(input);
  update(() => {
    // 이 골프장이 실제로 쓰는 새 그림만 옮긴다(넣었다가 지운 그림은 버림).
    const used = m.imageNamesOf([club]);
    for (const [name, bytes] of input.pendingImages) {
      if (!used.has(name)) continue;
      state.images.set(name, bytes);
      state.changedImages.add(name);
    }
    const exists = state.backup.clubs.some((c) => c.id === club.id);
    state.backup.clubs = exists ? state.backup.clubs.map((c) => (c.id === club.id ? club : c)) : [...state.backup.clubs, club];
    view.club = null;
    view.hole = null;
    view.message = { kind: 'ok', text: `${club.name} 을(를) 고쳤어요. [저장] 탭에서 백업 파일로 저장하세요.` };
  });
}

// ── 라운드 목록 ──

function visibleRounds() {
  const q = view.query.trim().toLowerCase();
  return [...state.backup.rounds]
    .filter((r) => !q || r.courseName.toLowerCase().includes(q))
    .filter((r) => !view.clubFilter || (view.clubFilter === '-' ? !r.courseId : r.courseId === view.clubFilter))
    .sort((a, b) => b.date - a.date);
}

function roundList() {
  const rounds = visibleRounds();
  const selected = [...view.selected].map(roundById).filter(Boolean);
  const allVisibleSelected = rounds.length > 0 && rounds.every((r) => view.selected.has(r.id));

  return h('div', {},
    h('div', { class: 'row' },
      h('h2', {}, `라운드 ${state.backup.rounds.length}개`),
      h('span', { class: 'spacer' }),
      h('input', { id: 'round-search', type: 'search', placeholder: '이름으로 찾기', value: view.query,
        oninput: (e) => {
          view.query = e.target.value;
          render();
        } }),
      h('select', { id: 'round-club-filter', onchange: (e) => update(() => (view.clubFilter = e.target.value)) },
        h('option', { value: '' }, '모든 골프장'),
        h('option', { value: '-', selected: view.clubFilter === '-' }, '골프장 없음'),
        state.backup.clubs.map((c) => h('option', { value: c.id, selected: view.clubFilter === c.id }, c.name)),
      ),
    ),
    selected.length ? bulkBar(selected) : null,
    h('div', { class: 'table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {},
          h('th', {}, h('input', { type: 'checkbox', checked: allVisibleSelected, 'aria-label': '모두 선택',
            onchange: (e) => update(() => rounds.forEach((r) => (e.target.checked ? view.selected.add(r.id) : view.selected.delete(r.id)))) })),
          h('th', {}, '날짜'), h('th', {}, '라운드'), h('th', {}, '골프장 · 코스'),
          h('th', { class: 'num' }, '홀'), h('th', { class: 'num' }, '타수'), h('th', {}, ''),
        )),
        h('tbody', {}, rounds.map((r) => {
          const combo = m.roundCombo(r, state.backup.clubs);
          const played = m.playedHoles(r).length;
          const tp = m.toPar(r);
          return h('tr', { class: 'clickable', onclick: (e) => {
            if (e.target.closest('input')) return;
            update(() => {
              view.roundId = r.id;
              view.assign = null;
              view.fieldErrors = {};
            });
          } },
            h('td', {}, h('input', { type: 'checkbox', checked: view.selected.has(r.id), 'aria-label': '선택',
              onchange: (e) => update(() => (e.target.checked ? view.selected.add(r.id) : view.selected.delete(r.id))) })),
            h('td', {}, fmtDate(r.date)),
            h('td', {}, r.courseName),
            h('td', {}, combo ? `${combo.club.name} · ${m.comboLabel(combo.combo)}` : h('span', { class: 'muted' }, r.frontNineId ? '지정됨(코스 없음)' : '지정 안 됨')),
            h('td', { class: 'num' }, `${played}/${r.holes.length}`),
            h('td', { class: 'num' }, played ? h('span', {}, `${m.totalStrokes(r)} `, h('span', { class: toParClass(tp) }, `(${m.formatToPar(tp)})`)) : '–'),
            h('td', {},
              r.inProgress ? h('span', { class: 'badge' }, '진행 중') : null, ' ',
              isChangedRound(r) ? h('span', { class: 'badge warn' }, '고침') : null),
          );
        })),
      ),
    ),
  );
}

function bulkBar(selected) {
  const holeCounts = new Set(selected.map((r) => r.holes.length));
  const panel = view.bulk;
  return h('div', { class: 'card' },
    h('div', { class: 'row' },
      h('strong', {}, `${selected.length}개 선택`),
      h('button', { onclick: () => update(() => (view.bulk = { type: 'nines', clubId: '', key: '', replacePars: false })) }, '골프장·코스 지정'),
      h('button', { onclick: () => update(() => (view.bulk = { type: 'rename', name: '' })) }, '이름 바꾸기'),
      h('button', { class: 'link', onclick: () => update(() => {
        view.selected.clear();
        view.bulk = null;
      }) }, '선택 해제'),
    ),
    panel?.type === 'nines' ? (holeCounts.size > 1
      ? h('p', { class: 'notice' }, '18홀과 9홀 라운드가 섞여 있어요. 홀 수가 같은 라운드만 골라 주세요.')
      : ninesPicker(panel, [...holeCounts][0], selected, () => applyBulkNines(selected))) : null,
    panel?.type === 'rename' ? h('div', { class: 'row' },
      h('input', { id: 'bulk-name', placeholder: '새 라운드 이름', value: panel.name, oninput: (e) => (panel.name = e.target.value) }),
      h('button', { class: 'primary', onclick: () => {
        const name = panel.name.trim();
        if (!name) return;
        update(() => {
          selected.forEach((r) => setRound(r.id, (x) => ({ ...x, courseName: name })));
          view.bulk = null;
          view.message = { kind: 'ok', text: `라운드 ${selected.length}개의 이름을 바꿨어요.` };
        });
      } }, '바꾸기'),
    ) : null,
  );
}

/**
 * 골프장 → 조합 고르기(라운드 편집과 여러 개 고치기가 함께 쓴다). panel: { clubId, key, replacePars }.
 * 파가 다르면 경고하고 [코스의 파로 바꾸기] 를 고를 수 있다.
 */
function ninesPicker(panel, holeCount, rounds, onApply) {
  const club = panel.clubId ? clubById(panel.clubId) : null;
  const options = club ? m.startOptions(club).filter((c) => m.comboHoleCount(c) === holeCount) : [];
  const combo = club && panel.key ? findCombo(club, panel.key) : null;
  const mismatched = combo ? rounds.filter((r) => m.parMismatches(r, combo) > 0).length : 0;

  return h('div', {},
    state.backup.clubs.length === 0 ? h('p', { class: 'notice' }, '골프장이 없어요. [골프장] 탭에서 먼저 만들어 주세요.') : null,
    h('div', { class: 'chips' }, state.backup.clubs.map((c) => h('button', { class: 'chip', 'aria-pressed': String(panel.clubId === c.id),
      onclick: () => update(() => Object.assign(panel, { clubId: c.id, key: '', replacePars: false })) }, c.name))),
    club ? h('div', {},
      h('p', { class: 'muted small' }, `전반 → 후반 (${holeCount}홀)`),
      options.length === 0 ? h('p', { class: 'notice' }, `이 골프장에는 ${holeCount}홀 조합이 없어요`) : null,
      h('div', { class: 'chips' }, options.map((c) => h('button', { class: 'chip', 'aria-pressed': String(panel.key === comboKey(c)),
        onclick: () => update(() => (panel.key = comboKey(c))) }, m.comboLabel(c)))),
    ) : null,
    combo && mismatched > 0 ? h('div', {},
      h('p', { class: 'notice' }, rounds.length === 1
        ? `이 라운드와 파가 다른 홀이 ${m.parMismatches(rounds[0], combo)}개 있어요. 그대로 지정해도 되고, 코스의 파로 바꿀 수도 있어요.`
        : `${mismatched}개 라운드가 코스와 파가 달라요.`),
      h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: panel.replacePars, onchange: (e) => (panel.replacePars = e.target.checked) }), '코스의 파로 바꾸기'),
    ) : null,
    h('div', { class: 'row' }, h('button', { class: 'primary', disabled: !combo, onclick: onApply }, '지정')),
  );
}

function applyBulkNines(selected) {
  const panel = view.bulk;
  const club = clubById(panel.clubId);
  const combo = findCombo(club, panel.key);
  update(() => {
    // 라운드 레이팅·슬로프가 비어 있으면 9홀 값의 합·평균으로 채운다(docs/spec-web-tool.md 10-2)
    selected.forEach((r) => setRound(r.id, (x) => m.withComboRatingsIfEmpty(m.withNines(x, club, combo, panel.replacePars), combo)));
    view.bulk = null;
    view.message = { kind: 'ok', text: `라운드 ${selected.length}개를 ${club.name} · ${m.comboLabel(combo)} 로 지정했어요.` };
  });
}

// ── 라운드 편집 ──

function roundEditor() {
  const r = roundById(view.roundId);
  if (!r) return h('p', {}, '라운드가 없어요');
  const combo = m.roundCombo(r, state.backup.clubs);
  const errors = view.fieldErrors;
  const field = (label, id, value, onValue, extra = {}) =>
    h('label', { class: 'field' }, label,
      h('input', { id, value: value ?? '', 'aria-invalid': errors[id] ? 'true' : null, onchange: (e) => onValue(e.target.value), ...extra }),
      errors[id] ? h('span', { class: 'small', style: 'color: var(--error)' }, errors[id]) : null);
  const setField = (id, fn) => (text) => update(() => {
    const err = fn(text);
    if (err) errors[id] = err;
    else delete errors[id];
  });
  const assign = view.assign ?? (view.assign = { clubId: combo?.club.id ?? r.courseId ?? '', key: combo ? comboKey(combo.combo) : '', replacePars: false });
  const siNow = r.holes.every((x) => x.strokeIndex != null) ? r.holes.map((x) => x.strokeIndex).join(',') : '';
  const tp = m.toPar(r);

  return h('div', {},
    h('div', { class: 'row' },
      h('button', { onclick: () => update(() => (view.roundId = null)) }, '← 목록'),
      h('h2', {}, r.courseName),
      isChangedRound(r) ? h('span', { class: 'badge warn' }, '고침') : null,
    ),
    h('div', { class: 'card' },
      h('div', { class: 'grid2' },
        field('라운드 이름', 'r-name', r.courseName, setField('r-name', (v) => {
          if (!v.trim()) return '이름이 비어 있어요';
          setRound(r.id, (x) => ({ ...x, courseName: v.trim() }));
        })),
        field('날짜', 'r-date', m.isoDay(r.date), setField('r-date', (v) => {
          if (!v) return '날짜를 골라 주세요';
          setRound(r.id, (x) => ({ ...x, date: m.withPickedDate(x.date, v) }));
        }), { type: 'date' }),
        field('코스 레이팅 (선택)', 'r-rating', r.courseRating ?? '', setField('r-rating', (v) => {
          const rating = m.parseRating(v);
          if (v.trim() && rating == null) return '30~90 사이 숫자예요';
          setRound(r.id, (x) => ({ ...x, courseRating: rating }));
        }), { inputmode: 'decimal' }),
        field('슬로프 (선택)', 'r-slope', r.slopeRating ?? '', setField('r-slope', (v) => {
          const slope = m.parseSlope(v);
          if (v.trim() && slope == null) return '55~155 사이 숫자예요';
          setRound(r.id, (x) => ({ ...x, slopeRating: slope }));
        }), { inputmode: 'numeric' }),
      ),
      field(`홀별 핸디캡 HCDP (선택, ${r.holes.length}개)`, 'r-si', siNow, setField('r-si', (v) => {
        const si = m.parseStrokeIndexes(v, r.holes.length);
        if (si.kind === 'invalid') return `${r.holes.length}개, 1~18, 서로 다른 숫자로 적어 주세요`;
        setRound(r.id, (x) => m.setRoundStrokeIndexes(x, si.kind === 'valid' ? si.indexes : null));
      }), { inputmode: 'decimal' }),
      h('label', { class: 'field' }, '메모',
        h('textarea', { id: 'r-note', onchange: (e) => update(() => setRound(r.id, (x) => ({ ...x, note: e.target.value }))) }, r.note ?? '')),
      h('label', { class: 'row' },
        h('input', { type: 'checkbox', checked: r.inProgress, onchange: (e) => update(() => setRound(r.id, (x) => ({ ...x, inProgress: e.target.checked }))) }),
        '진행 중 (켜면 폰이 워치로 보냄)'),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'row' },
        h('strong', {}, '전반·후반 코스'),
        h('span', {}, combo ? `${combo.club.name} · ${m.comboLabel(combo.combo)}` : r.frontNineId ? '지정됨 (골프장·코스가 지워짐)' : '지정 안 됨'),
        h('span', { class: 'spacer' }),
        r.frontNineId ? h('button', { class: 'link', onclick: () => update(() => {
          setRound(r.id, m.withoutNines);
          view.assign = null;
        }) }, '지정 풀기') : null,
      ),
      ninesPicker(assign, r.holes.length, [r], () => {
        const club = clubById(assign.clubId);
        const c = findCombo(club, assign.key);
        update(() => {
          setRound(r.id, (x) => m.withComboRatingsIfEmpty(m.withNines(x, club, c, assign.replacePars), c));
          view.message = { kind: 'ok', text: `${club.name} · ${m.comboLabel(c)} 로 지정했어요.` };
        });
      }),
    ),
    h('div', { class: 'row' },
      h('h3', {}, '홀별 기록'),
      h('span', { class: 'muted small' }, `합계 ${m.totalStrokes(r)}타 (${m.formatToPar(tp)}) · 퍼팅 ${m.playedHoles(r).reduce((s, x) => s + x.putts, 0)}`),
    ),
    holesTable(r),
    h('p', { class: 'muted small' }, '타수를 고치면 샷이 있는 홀은 그 값으로 고정돼요(폰의 파·보기·더블과 같음). 샷 기록은 여기서 고치지 않아요.'),
    h('div', { class: 'row' },
      h('button', { class: 'danger', onclick: () => {
        if (!confirm(`${fmtDate(r.date)} ${r.courseName} 라운드를 지울까요? 폰은 가져올 때 한 번 더 물어보고, 지우면 워치에서도 지워져요.`)) return;
        update(() => {
          deleteItem(state, 'round', r.id);
          view.selected.delete(r.id);
          view.roundId = null;
          view.message = { kind: 'ok', text: '라운드를 지웠어요. [저장] 탭에서 되돌릴 수 있어요.' };
        });
      } }, '이 라운드 지우기'),
    ),
  );
}

function holesTable(r) {
  const edit = (number, fn) => update(() => setRound(r.id, (x) => m.updateHole(x, number, fn)));
  const num = (id, value, onValue, attrs = {}) =>
    h('input', { id, type: 'number', inputmode: 'numeric', value, onchange: (e) => onValue(Number(e.target.value || 0)), ...attrs });

  return h('div', { class: 'table-wrap' },
    h('table', {},
      h('thead', {}, h('tr', {},
        ['홀', '파', '타수', '퍼팅', '벌타', '페어웨이', 'GIR', 'HCDP', '샷'].map((t) => h('th', {}, t)),
      )),
      h('tbody', {}, r.holes.map((hole) => {
        const n = hole.number;
        const shots = hole.shots ?? [];
        return h('tr', {},
          h('td', {}, h('strong', {}, n)),
          h('td', {}, h('select', { id: `h${n}-par`, onchange: (e) => edit(n, (x) => m.setPar(x, Number(e.target.value))) },
            [3, 4, 5, 6].map((p) => h('option', { value: p, selected: hole.par === p }, p)))),
          h('td', {}, num(`h${n}-strokes`, hole.strokes || '', (v) => edit(n, (x) => m.setStrokes(x, v)), { min: 0, max: 20, placeholder: '–',
            class: m.isPlayed(hole) ? toParClass(hole.strokes - hole.par) : '' })),
          h('td', {}, num(`h${n}-putts`, hole.putts, (v) => edit(n, (x) => m.setPutts(x, v)), { min: 0, max: 9 }),
            hole.puttsEstimated ? h('span', { class: 'muted small', title: '추정값' }, '*') : null),
          h('td', {}, num(`h${n}-pen`, hole.penalties, (v) => edit(n, (x) => m.setPenalties(x, v)), { min: 0, max: 9 })),
          h('td', {}, h('select', { id: `h${n}-fw`, disabled: hole.par === 3,
            onchange: (e) => edit(n, (x) => m.setFairway(x, e.target.value === '' ? null : e.target.value === 'true')) },
            h('option', { value: '', selected: hole.fairwayHit == null }, '–'),
            h('option', { value: 'true', selected: hole.fairwayHit === true }, 'O'),
            h('option', { value: 'false', selected: hole.fairwayHit === false }, 'X'))),
          h('td', {}, h('input', { id: `h${n}-gir`, type: 'checkbox', checked: hole.greenInRegulation,
            onchange: (e) => edit(n, (x) => m.setGir(x, e.target.checked)) }),
            hole.girEstimated ? h('span', { class: 'muted small', title: '추정값' }, '*') : null),
          h('td', { class: 'num' }, hole.strokeIndex ?? '–'),
          h('td', { class: 'muted small' }, shots.length ? `${shots.length} · ${shots.map((s) => bagName(s.clubId)).join(', ')}` : ''),
        );
      })),
    ),
  );
}

// ── 저장 ──

function saveScreen() {
  const changes = changesOf(state);
  const problems = saveProblems(state);
  const total = changeCount(changes);
  const imagesChanged = state.changedImages.size > 0;
  // 그림을 넣거나 바꿨으면, 또는 zip 으로 열었으면 zip 이 기본
  const zipFirst = imagesChanged || state.fromZip;
  const canOverwrite = !!fileHandle?.createWritable && (state.fromZip || !imagesChanged);
  const imageNames = m.imageNamesOf(state.backup.clubs);
  const missing = [...imageNames].filter((n) => !state.images.has(n)).length;

  const zipButton = h('button', { class: zipFirst ? 'primary' : null, disabled: problems.length > 0, onclick: () => save('download', 'zip') },
    '백업 파일로 저장 (그림 포함 zip)');
  const jsonButton = h('button', { class: zipFirst ? null : 'primary', disabled: problems.length > 0, onclick: () => save('download', 'json') },
    '백업 파일로 저장 (JSON)');

  return h('div', {},
    h('h2', {}, '저장'),
    h('div', { class: 'card' },
      total === 0 ? h('p', { class: 'muted' }, '아직 고친 것이 없어요.') : h('div', {},
        h('p', {}, `골프장 새로 ${changes.newClubs.length} · 고침 ${changes.changedClubs.length} / 라운드 고침 ${changes.changedRounds.length}` +
          (changes.deletions.length ? ` / 지움 ${changes.deletions.length}` : '') + (imagesChanged ? ` / 그림 ${state.changedImages.size}장` : '')),
        h('ul', { class: 'small' },
          changes.newClubs.map((c) => h('li', {}, `새 골프장: ${c.name}`)),
          changes.changedClubs.map((c) => h('li', {}, `골프장: ${c.name}`)),
          changes.changedRounds.map((r) => h('li', {}, `라운드: ${fmtDate(r.date)} ${r.courseName}`)),
          changes.deletions.map((t) => h('li', {},
            `지움 · ${t.kind === 'club' ? '골프장' : '라운드'}: ${t.date ? `${fmtDate(t.date)} ` : ''}${t.name} `,
            h('button', { class: 'link', onclick: () => update(() => undoDelete(state, t.kind, t.id)) }, '되돌리기'))),
        ),
      ),
      problems.length ? h('div', { class: 'notice error' }, '고쳐야 저장할 수 있어요:',
        h('ul', {}, problems.map((p) => h('li', {}, `${p.name}: ${p.problems.join(', ')}`)))) : null,
      imagesChanged ? h('p', { class: 'notice warn' }, '그림을 넣거나 바꿨어요. 폰에 그림이 들어가려면 그림 포함 zip 으로 저장하세요(JSON 에는 그림이 없어요).') : null,
      missing > 0 ? h('p', { class: 'muted small' }, `야디지북 그림 ${missing}장은 이 파일에 없어요(폰에만 있음). JSON·zip 어느 쪽으로 저장해도 폰의 그 그림은 그대로 남아요.`) : null,
      h('p', { class: 'notice' }, '이 파일을 만든 뒤 폰에서 같은 라운드·골프장을 또 고쳤다면, 가져올 때 이 파일의 내용이 이겨요(통째로). 한쪽에서만 고쳐 주세요.'),
      h('div', { class: 'row' },
        zipFirst ? [zipButton, jsonButton] : [jsonButton, zipButton],
        canOverwrite ? h('button', { disabled: problems.length > 0, onclick: () => save('overwrite', state.fromZip ? 'zip' : 'json') }, `연 파일에 덮어쓰기 (${fileName})`) : null,
      ),
    ),
    h('div', { class: 'card' },
      h('h3', {}, '폰에 넣기'),
      h('p', {}, '저장한 파일을 Google Drive 등에 두고, 폰 라운드 탭 ⋮ → 백업 파일 가져오기 로 고르세요. 수정 시각이 더 최신인 것만 들어가고, 폰의 기록은 지워지지 않아요. ',
        '웹에서 지운 라운드·골프장은 폰이 목록을 보여 주고 물어본 뒤에 지워요.'),
      h('p', { class: 'muted small' }, '이 파일(백업 v3)은 폰 앱 1.9 이상에서 가져올 수 있어요.'),
    ),
  );
}

async function save(mode, kind) {
  const { text, backup, state: next } = buildSave(state);
  let body = text;
  let note = '';
  if (kind === 'zip') {
    const zip = buildZip(text, backup, state.images);
    body = zip.bytes;
    note = ` (그림 ${zip.images}장${zip.missing ? `, 폰에만 있는 그림 ${zip.missing}장 제외` : ''})`;
  }
  const name = mode === 'overwrite' ? fileName : saveFileName(Date.now(), kind);
  try {
    if (mode === 'overwrite') {
      const writable = await fileHandle.createWritable();
      await writable.write(body);
      await writable.close();
    } else {
      const url = URL.createObjectURL(new Blob([body], { type: kind === 'zip' ? 'application/zip' : 'application/json' }));
      const a = h('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (e) {
    showError(`저장하지 못했어요: ${e.message}`);
    return;
  }
  state = next;
  scheduleDraft();
  view.message = { kind: 'ok', text: mode === 'overwrite' ? `${name} 에 저장했어요${note}. 폰에서 가져오세요.` : `${name} 로 내려받았어요${note}. 폰에서 가져오세요.` };
  render();
}

// ── 시작 ──

window.addEventListener('beforeunload', (e) => {
  if (state && hasChanges()) e.preventDefault();
});

draftInfo = await loadDraft();
render();
