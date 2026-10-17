// 골프 스코어 웹 도구 화면. 계산은 model.js, 파일은 backup.js 가 하고 여기서는 보여 주고 고치기만 한다.
// 상태를 고칠 때마다 화면 전체를 다시 그린다(항목 수가 적어 충분히 빠르다). 포커스는 그린 뒤 되살린다.

import * as m from './model.js';
import { BackupError, buildSave, changesOf, openBackup, saveFileName, saveProblems } from './backup.js';
import { clearDraft, loadDraft, saveDraft } from './draft.js';

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
  const changes = changesOf(state);
  const count = changes.newClubs.length + changes.changedClubs.length + changes.changedRounds.length;
  const tab = (id, label) =>
    h('button', {
      'aria-current': view.tab === id ? 'page' : null,
      onclick: () => update(() => {
        view.tab = id;
        view.club = null;
        view.roundId = null;
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
  if (view.tab === 'clubs') return view.club ? clubEditor() : clubList();
  if (view.tab === 'rounds') return view.roundId ? roundEditor() : roundList();
  return saveScreen();
}

// ── 시작 ──

function startScreen() {
  const drop = h('div', { class: 'drop' },
    h('p', {}, h('strong', {}, '폰에서 내보낸 백업 파일(JSON)을 여세요')),
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
    if (file) loadText(await file.text(), file.name, null);
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
        h('li', {}, '폰: 라운드 탭 ⋮ → 백업 파일로 저장 (JSON)'),
        h('li', {}, '여기서 열고 골프장·라운드를 고친 뒤 [저장] 탭에서 백업 파일로 저장'),
        h('li', {}, '폰: 라운드 탭 ⋮ → 백업 파일 가져오기 → 고친 것만 들어가요'),
      ),
    ),
  );
}

async function pickFile() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: '골프 스코어 백업', accept: { 'application/json': ['.json'] } }],
      });
      const file = await handle.getFile();
      loadText(await file.text(), file.name, handle);
    } catch (e) {
      if (e?.name !== 'AbortError') showError(`파일을 열지 못했어요: ${e.message}`);
    }
    return;
  }
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (file) loadText(await file.text(), file.name, null);
  });
  input.click();
}

function loadText(text, name, handle) {
  if (state && hasChanges() && !confirm('지금 고친 내용을 저장하지 않고 다른 파일을 열까요?')) return;
  try {
    state = openBackup(text);
  } catch (e) {
    state = null;
    showError(e instanceof BackupError ? e.message : `파일을 열지 못했어요: ${e.message}`);
    return;
  }
  fileName = name;
  fileHandle = handle;
  Object.assign(view, { tab: 'clubs', club: null, roundId: null, selected: new Set(), bulk: null, assign: null, fieldErrors: {} });
  const b = state.backup;
  view.message = { kind: 'ok', text: `${name} — 라운드 ${b.rounds.length}개 · 골프장 ${b.clubs.length}개 · 백업 ${fmtDate(b.exportedAt)}` };
  scheduleDraft();
  render();
}

function showError(text) {
  view.message = { kind: 'error', text };
  render();
}

const hasChanges = () => {
  const c = changesOf(state);
  return c.newClubs.length + c.changedClubs.length + c.changedRounds.length > 0;
};

// ── 임시 보관 ──

let draftTimer = null;
function scheduleDraft() {
  if (!state) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    saveDraft({
      backupText: JSON.stringify(state.backup),
      originals: { rounds: [...state.originals.rounds], clubs: [...state.originals.clubs] },
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
    originals: { rounds: new Map(d.originals.rounds), clubs: new Map(d.originals.clubs) },
  };
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
          h('button', { onclick: () => update(() => (view.club = clubInput(club))) }, '고치기'),
        ),
        h('div', { class: 'muted small' }, `9홀 코스 ${club.nines.length}개 · ${club.nines.map((n) => n.name).join('·')} · 이 골프장으로 친 라운드 ${rounds}개`),
        club.nines.map((n) => h('div', { class: 'small' },
          `${n.name}  파 ${n.pars.join(' ')} (${n.pars.reduce((a, b) => a + b, 0)})`,
          n.strokeIndexes ? `  · HCDP ${n.strokeIndexes.join(' ')}` : '',
          n.courseRating != null || n.slopeRating != null ? `  · 레이팅 ${n.courseRating ?? '–'} / 슬로프 ${n.slopeRating ?? '–'}` : '',
        )),
      );
    }),
  );
}

/**
 * 골프장 편집 입력 상태. 9홀 코스마다 홀별 칸(파 9칸, HCDP 9칸)과 9홀 레이팅·슬로프 글자를 둔다.
 * 모르는 필드는 rest 에 그대로 둔다(저장할 때 다시 씀).
 */
function nineInputOf(n) {
  return {
    rest: n, id: n.id, isNew: false, name: n.name,
    pars: n.pars.map(String),
    sis: n.strokeIndexes ? n.strokeIndexes.map(String) : Array(9).fill(''),
    ratingText: n.courseRating != null ? String(n.courseRating) : '',
    slopeText: n.slopeRating != null ? String(n.slopeRating) : '',
  };
}

function freshNineInput(name, pars) {
  return { rest: {}, id: m.newId(), isNew: true, name, pars: pars.map(String), sis: Array(9).fill(''), ratingText: '', slopeText: '' };
}

function clubInput(club) {
  if (!club) {
    return {
      rest: {}, id: m.newId(), isNew: true, name: '', updatedAt: 0,
      nines: [freshNineInput('OUT', m.DEFAULT_PARS_18.slice(0, 9)), freshNineInput('IN', m.DEFAULT_PARS_18.slice(9))],
    };
  }
  return { rest: club, id: club.id, isNew: false, name: club.name, updatedAt: club.updatedAt, nines: club.nines.map(nineInputOf) };
}

const parCellOk = (v) => /^\d+$/.test(v.trim()) && Number(v) >= 3 && Number(v) <= 6;

/** HCDP 칸 하나가 틀렸는지: 1~18 정수이고 같은 코스에서 겹치지 않아야 한다. 빈 칸은 여기서 보지 않는다. */
function siCellBad(sis, i) {
  const v = sis[i].trim();
  if (v === '') return false;
  if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 18) return true;
  return sis.some((other, j) => j !== i && other.trim() !== '' && Number(other) === Number(v));
}

/** 9홀 코스 입력의 문제(칸 단위 검사). 저장을 막는다. */
function nineInputProblems(n) {
  const problems = [];
  const label = n.name.trim() || '코스';
  if (!n.name.trim()) problems.push('코스 이름이 비어 있어요');
  if (n.pars.some((v) => !parCellOk(v))) problems.push(`${label}: 파는 3~6 숫자로 적어 주세요`);
  const filled = n.sis.filter((v) => v.trim() !== '').length;
  if (filled > 0 && filled < 9) problems.push(`${label}: HCDP 는 9칸 모두 채우거나 모두 비워 주세요`);
  if (n.sis.some((_, i) => siCellBad(n.sis, i))) problems.push(`${label}: HCDP 는 1~18, 서로 다른 숫자로 적어 주세요`);
  if (n.ratingText.trim() && m.parseNineRating(n.ratingText) == null) problems.push(`${label}: 코스 레이팅은 ${m.NINE_RATING[0]}~${m.NINE_RATING[1]} (9홀 값)`);
  if (n.slopeText.trim() && m.parseSlope(n.slopeText) == null) problems.push(`${label}: 슬로프는 55~155`);
  return problems;
}

function clubFromInput(input) {
  return {
    ...input.rest,
    id: input.id,
    name: input.name.trim(),
    nines: input.nines.map((n) => {
      const allSi = n.sis.every((v) => v.trim() !== '');
      return {
        ...n.rest,
        id: n.id,
        name: n.name.trim(),
        pars: n.pars.map((v) => (parCellOk(v) ? Number(v) : 4)),
        strokeIndexes: allSi ? n.sis.map(Number) : null,
        courseRating: m.parseNineRating(n.ratingText),
        slopeRating: m.parseSlope(n.slopeText),
      };
    }),
    updatedAt: input.updatedAt,
  };
}

/** 엔터를 누르면 갈 칸: 파 1→9 → HCDP 1→9 → 다음 코스 파 1(마지막 코스면 그 코스 레이팅). */
function nextCellId(i, row, h, nineCount) {
  if (h < 8) return `n${i}-${row}${h + 1}`;
  if (row === 'p') return `n${i}-s0`;
  return i + 1 < nineCount ? `n${i + 1}-p0` : `n${i}-cr`;
}

/** 9홀 코스 하나의 가로 표(스코어카드 모양). */
function nineGrid(input, n, i) {
  const cell = (row, col) => {
    const values = row === 'p' ? n.pars : n.sis;
    const bad = row === 'p' ? !parCellOk(values[col]) : siCellBad(values, col);
    return h('td', {}, h('input', {
      id: `n${i}-${row}${col}`, value: values[col], inputmode: 'numeric', maxlength: 2, autocomplete: 'off',
      'aria-label': `${m.ordinalCourse(i)} ${col + 1}번 홀 ${row === 'p' ? '파' : 'HCDP'}`,
      'aria-invalid': bad ? 'true' : null,
      oninput: (e) => (values[col] = e.target.value),
      onchange: () => render(),
      onfocus: (e) => e.target.select(),
      onkeydown: (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        values[col] = e.target.value;
        render();
        const next = document.getElementById(nextCellId(i, row, col, input.nines.length));
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
  };
  const total = n.pars.reduce((s, v) => s + (parCellOk(v) ? Number(v) : 0), 0);
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'nine-grid' },
      h('thead', {}, h('tr', {}, h('th', {}, '홀'), [...Array(9)].map((_, k) => h('th', { class: 'num' }, k + 1)), h('th', { class: 'num' }, '합계'))),
      h('tbody', {},
        h('tr', {}, h('th', {}, '파'), [...Array(9)].map((_, k) => cell('p', k)), h('td', { class: 'num' }, h('strong', {}, total))),
        h('tr', {}, h('th', {}, 'HCDP'), [...Array(9)].map((_, k) => cell('s', k)), h('td', {})),
      ),
    ),
  );
}

function clubEditor() {
  const input = view.club;
  const club = clubFromInput(input);
  const problems = [...(input.name.trim() ? [] : ['골프장 이름이 비어 있어요']), ...input.nines.flatMap(nineInputProblems)];
  const changeAndRender = (fn) => (e) => {
    fn(e.target);
    render();
  };

  return h('div', {},
    h('div', { class: 'row' },
      h('button', { onclick: () => update(() => (view.club = null)) }, '← 목록'),
      h('h2', {}, input.isNew ? '골프장 추가' : '골프장 고치기'),
    ),
    h('div', { class: 'card' },
      h('label', { class: 'field' }, '골프장 이름',
        h('input', { id: 'club-name', value: input.name, onchange: changeAndRender((t) => (input.name = t.value)) })),
      h('p', { class: 'muted small' },
        '9홀 코스마다 홀별 파·HCDP 를 칸에 적어요. 엔터를 누르면 다음 홀로 넘어가요. ',
        '"4,4,3,5…" 를 한 칸에 붙여 넣으면 오른쪽 칸으로 나눠 채워요. HCDP 는 9칸 모두 적거나 모두 비워 두세요. ',
        '27·36홀 골프장은 [9홀 코스 추가] 로 더해요. 골프장 삭제는 폰 코스 탭에서 해요.'),
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
      )),
      h('button', { onclick: () => {
        input.nines.push(freshNineInput('', Array(9).fill(4)));
        render();
        document.getElementById(`n${input.nines.length - 1}-name`)?.focus();
      } }, '+ 9홀 코스 추가'),
      problems.length ? h('ul', { class: 'problems' }, problems.map((p) => h('li', {}, p))) : null,
      club.nines.length >= 2 && club.nines.every((x) => x.courseRating != null && x.slopeRating != null)
        ? h('p', { class: 'muted small' }, `18홀 예: ${club.nines[0].name}+${club.nines[1].name} = 레이팅 ${m.comboRatings({ front: club.nines[0], back: club.nines[1] }).courseRating} / 슬로프 ${m.comboRatings({ front: club.nines[0], back: club.nines[1] }).slopeRating} (합·평균)`)
        : null,
    ),
    h('div', { class: 'sticky-actions' },
      h('button', { class: 'primary', disabled: problems.length > 0, onclick: () => saveClub(input) }, '골프장 저장'),
      h('button', { onclick: () => update(() => (view.club = null)) }, '취소'),
    ),
  );
}

function removeNine(input, index) {
  const nine = input.nines[index];
  if (!nine.isNew) {
    const n = m.roundsUsingNine(state.backup.rounds, input.id, nine.id);
    if (n > 0 && !confirm(`${nine.name} 코스로 친 라운드 ${n}개의 코스 연결이 끊깁니다(라운드 기록은 남아요). 삭제할까요?`)) return;
  }
  input.nines.splice(index, 1);
  render();
}

function saveClub(input) {
  const club = clubFromInput(input);
  update(() => {
    const exists = state.backup.clubs.some((c) => c.id === club.id);
    state.backup.clubs = exists ? state.backup.clubs.map((c) => (c.id === club.id ? club : c)) : [...state.backup.clubs, club];
    view.club = null;
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
  const total = changes.newClubs.length + changes.changedClubs.length + changes.changedRounds.length;
  const canOverwrite = !!fileHandle?.createWritable;

  return h('div', {},
    h('h2', {}, '저장'),
    h('div', { class: 'card' },
      total === 0 ? h('p', { class: 'muted' }, '아직 고친 것이 없어요.') : h('div', {},
        h('p', {}, `골프장 새로 ${changes.newClubs.length} · 고침 ${changes.changedClubs.length} / 라운드 고침 ${changes.changedRounds.length}`),
        h('ul', { class: 'small' },
          changes.newClubs.map((c) => h('li', {}, `새 골프장: ${c.name}`)),
          changes.changedClubs.map((c) => h('li', {}, `골프장: ${c.name}`)),
          changes.changedRounds.map((r) => h('li', {}, `라운드: ${fmtDate(r.date)} ${r.courseName}`)),
        ),
      ),
      problems.length ? h('div', { class: 'notice error' }, '고쳐야 저장할 수 있어요:',
        h('ul', {}, problems.map((p) => h('li', {}, `${p.name}: ${p.problems.join(', ')}`)))) : null,
      h('p', { class: 'notice' }, '이 파일을 만든 뒤 폰에서 같은 라운드를 또 고쳤다면, 가져올 때 이 파일의 내용이 이겨요(라운드 통째로). 한쪽에서만 고쳐 주세요.'),
      h('div', { class: 'row' },
        h('button', { class: 'primary', disabled: problems.length > 0, onclick: () => save('download') }, '백업 파일로 저장'),
        canOverwrite ? h('button', { disabled: problems.length > 0, onclick: () => save('overwrite') }, `연 파일에 덮어쓰기 (${fileName})`) : null,
      ),
    ),
    h('div', { class: 'card' },
      h('h3', {}, '폰에 넣기'),
      h('p', {}, '저장한 파일을 Google Drive 등에 두고, 폰 라운드 탭 ⋮ → 백업 파일 가져오기 로 고르세요. 수정 시각이 더 최신인 것만 들어가고, 폰의 기록은 지워지지 않아요.'),
    ),
  );
}

async function save(mode) {
  const { text, state: next } = buildSave(state);
  try {
    if (mode === 'overwrite') {
      const writable = await fileHandle.createWritable();
      await writable.write(text);
      await writable.close();
    } else {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = h('a', { href: url, download: saveFileName() });
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
  view.message = { kind: 'ok', text: mode === 'overwrite' ? `${fileName} 에 저장했어요. 폰에서 가져오세요.` : `${saveFileName()} 로 내려받았어요. 폰에서 가져오세요.` };
  render();
}

// ── 시작 ──

window.addEventListener('beforeunload', (e) => {
  if (state && hasChanges()) e.preventDefault();
});

draftInfo = await loadDraft();
render();
