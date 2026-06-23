// 두 아이의 주간 시간표 PWA — state, sync, render

const STORAGE_KEY = 'school-timetable-state-v1';
const TOKEN_KEY   = 'school-timetable-edit-token';
const API_BASE    = 'https://school-timetable-api.junyoung-cha83.workers.dev';
const SAVE_DEBOUNCE_MS = 800;

const DAYS = [
  { id: 'mon', label: '월요일', short: '월' },
  { id: 'tue', label: '화요일', short: '화' },
  { id: 'wed', label: '수요일', short: '수' },
  { id: 'thu', label: '목요일', short: '목' },
  { id: 'fri', label: '금요일', short: '금' },
  { id: 'sat', label: '토요일', short: '토' },
];
const CHILDREN = [
  { id: 'seungho', label: '승호' },
  { id: 'seunga',  label: '승아' },
];
const KINDS = [
  { id: 'school',       label: '학교' },
  { id: 'kindergarten', label: '유치원' },
  { id: 'academy',      label: '학원' },
];
const PALETTE = [
  '#fde68a', '#fca5a5', '#93c5fd', '#86efac',
  '#c4b5fd', '#fdba74', '#67e8f9', '#d1d5db',
];

function DEFAULT_STATE() { return { version: 1, entries: [], events: [], members: [] }; }

let state = DEFAULT_STATE();
let activeTab = 'grid';          // 'detail' | 'grid' | 'calendar' | 'list'
let activeChild = 'seungho';     // 'seungho' | 'seunga' | 'seungseung' (grid 전용)

// 달력/목록(가족스케줄) 상태
const WD = ['일', '월', '화', '수', '목', '금', '토'];
let calView = (() => { const d = new Date(); d.setDate(1); return d; })();
let calSel = null;               // 선택한 날짜 'YYYY-MM-DD'
let evShowPast = false;          // 목록: 지난 일정 펼침
let editingEvId = null;
let evMemberSel = null;          // 일정 모달에서 선택된 담당자 id

// ── 유틸 ─────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }
function nextId() {
  const max = state.entries.reduce((m, e) => {
    const n = parseInt(String(e.id || '').replace(/\D/g, '')) || 0;
    return Math.max(m, n);
  }, 0);
  return 'e' + (max + 1);
}
function escapeAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// HH:mm → 분 (정수). 잘못된 입력이면 null
function parseTimeMin(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}
// 분 → HH:mm
function fmtMin(min) {
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return String(h).padStart(2,'0') + ':' + String(m).padStart(2,'0');
}

// ── 영속화 ─────────────────────────────────────────
let _saveTimer = null;
let _saveCtrl  = null;
let _syncStatus = 'idle';
let _refreshInFlight = false;

function setSyncStatus(s) {
  _syncStatus = s;
  const el = document.getElementById('syncStatus');
  if (!el) return;
  const map = {
    idle:        { text: '',         cls: '' },
    pending:     { text: '변경됨',    cls: 'pending' },
    saving:      { text: '저장중…',   cls: 'saving' },
    saved:       { text: '저장됨 ✓',  cls: 'saved' },
    error:       { text: '오프라인',  cls: 'error' },
    unauthorized:{ text: '토큰 오류', cls: 'error' },
    readonly:    { text: '읽기전용',  cls: 'readonly' },
  };
  const m = map[s] || map.idle;
  el.textContent = m.text;
  el.className = 'sync-status ' + m.cls;
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.entries)) return parsed;
  } catch (e) {}
  return null;
}

function saveLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { alert('localStorage 저장 실패 — 용량 초과 가능성'); }

  const token = getEditToken();
  if (!token) { setSyncStatus('readonly'); return; }

  setSyncStatus('pending');
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => { _saveTimer = null; pushToServer(); }, SAVE_DEBOUNCE_MS);
}

async function pushToServer() {
  const token = getEditToken();
  if (!token) return;
  if (_saveCtrl) _saveCtrl.abort();
  _saveCtrl = new AbortController();
  setSyncStatus('saving');
  try {
    const res = await fetch(`${API_BASE}/api/data`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Edit-Token': token },
      body: JSON.stringify(state),
      signal: _saveCtrl.signal,
    });
    if (res.ok) setSyncStatus('saved');
    else if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      updateEditUI();
      setSyncStatus('unauthorized');
      alert('편집 비밀번호가 잘못됐습니다 — 다시 입력하세요.');
    }
    else if (res.status === 413) {
      setSyncStatus('error');
      alert('데이터 크기 초과');
    }
    else setSyncStatus('error');
  } catch (e) {
    if (e.name !== 'AbortError') setSyncStatus('error');
  }
}

async function fetchFromServer() {
  try {
    const res = await fetch(`${API_BASE}/api/data`, { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    if (json && Array.isArray(json.entries)) return json;
  } catch (e) {}
  return null;
}

async function loadInitial() {
  const remote = await fetchFromServer();
  if (remote) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(remote)); } catch (e) {}
    return migrate(remote);
  }
  const local = loadLocal();
  if (local) return migrate(local);
  try {
    const res = await fetch('data/default.json?t=' + Date.now());
    if (res.ok) {
      const json = await res.json();
      if (json) return migrate(json);
    }
  } catch (e) {}
  return DEFAULT_STATE();
}

function migrate(loaded) {
  if (!loaded || !Array.isArray(loaded.entries)) return DEFAULT_STATE();
  loaded.version = loaded.version || 1;
  for (const e of loaded.entries) {
    e.child   = (e.child === 'seunga') ? 'seunga' : 'seungho';
    e.day     = DAYS.some(d => d.id === e.day) ? e.day : 'mon';
    e.kind    = KINDS.some(k => k.id === e.kind) ? e.kind : 'school';
    e.content = typeof e.content === 'string' ? e.content : '';
    e.start   = typeof e.start === 'string' ? e.start : '';
    e.end     = typeof e.end   === 'string' ? e.end   : '';
    e.place   = typeof e.place === 'string' ? e.place : '';
    e.memo    = typeof e.memo  === 'string' ? e.memo  : '';
    e.color   = (typeof e.color === 'string' && /^#[0-9a-f]{6}$/i.test(e.color)) ? e.color : PALETTE[0];
    e.created_at = e.created_at || nowIso();
    e.updated_at = e.updated_at || e.created_at;
  }
  // 가족스케줄: events / members 정규화(없으면 빈 배열 유지)
  if (!Array.isArray(loaded.events)) loaded.events = [];
  if (!Array.isArray(loaded.members)) loaded.members = [];
  for (const ev of loaded.events) {
    ev.title = typeof ev.title === 'string' ? ev.title : '';
    ev.startDate = typeof ev.startDate === 'string' ? ev.startDate : (ev.date || '');
    ev.endDate = typeof ev.endDate === 'string' && ev.endDate ? ev.endDate : ev.startDate;
    ev.startTime = typeof ev.startTime === 'string' ? ev.startTime : (ev.time || '');
    ev.endTime = typeof ev.endTime === 'string' ? ev.endTime : '';
    ev.memberId = ev.memberId || null;
    ev.memo = typeof ev.memo === 'string' ? ev.memo : '';
    ev.created_at = ev.created_at || nowIso();
    ev.updated_at = ev.updated_at || ev.created_at;
  }
  for (const m of loaded.members) {
    m.name = typeof m.name === 'string' ? m.name : '';
    m.color = (typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color)) ? m.color : PALETTE[0];
  }
  return loaded;
}

// 미저장 변경 보호: 자동 새로고침은 pending/saving 일 땐 skip.
// manual: 직전 push 가 있으면 flush 한 뒤 refetch 는 생략(KV eventual consistency 회피).
async function refreshFromServerNow({ manual = false } = {}) {
  if (_refreshInFlight) return;
  if (!manual && (_syncStatus === 'pending' || _syncStatus === 'saving')) return;
  _refreshInFlight = true;
  if (manual) setSyncStatus('saving');
  try {
    const hadPending = !!_saveTimer || _syncStatus === 'pending' || _syncStatus === 'saving';
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    if (_syncStatus === 'pending' || _syncStatus === 'saving') await pushToServer();
    if (hadPending) {
      if (manual && _syncStatus !== 'error' && _syncStatus !== 'unauthorized') {
        setSyncStatus(getEditToken() ? 'saved' : 'readonly');
      }
      render();
      return;
    }
    const remote = await fetchFromServer();
    if (!remote) { if (manual) setSyncStatus('error'); return; }
    state = migrate(remote);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
    if (manual) setSyncStatus(getEditToken() ? 'saved' : 'readonly');
    render();
  } finally {
    _refreshInFlight = false;
  }
}

// 사용자가 직접 누르는 저장 — debounce 큐 flush 후 즉시 푸시 + 시각 피드백.
// 데이터는 입력 즉시 in-memory + localStorage 에 반영되지만, 명시적 버튼이 있어
// 사용자에게 안정감을 주고 서버 푸시도 보장.
async function manualSave() {
  const btn = document.getElementById('btnSave');
  if (!btn) return;
  if (!getEditToken()) {
    if (confirm('편집 모드가 아닙니다. 비밀번호를 입력하시겠습니까?')) {
      promptEditToken();
    }
    return;
  }
  btn.disabled = true;
  btn.classList.remove('saved', 'error');
  const original = btn.textContent;
  btn.textContent = '저장중…';
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  await pushToServer();
  btn.disabled = false;
  if (_syncStatus === 'saved') {
    btn.classList.add('saved');
    btn.textContent = '저장됨 ✓';
    setTimeout(() => {
      btn.classList.remove('saved');
      btn.textContent = '저장';
    }, 1500);
  } else if (_syncStatus === 'error') {
    btn.classList.add('error');
    btn.textContent = '오프라인';
    setTimeout(() => {
      btn.classList.remove('error');
      btn.textContent = '저장';
    }, 2000);
  } else {
    btn.textContent = original;
  }
}

// ── 편집 토큰 ─────────────────────────────────
function getEditToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function promptEditToken() {
  const cur = getEditToken();
  const v = prompt(cur ? '편집 비밀번호 (비우면 로그아웃):' : '편집 비밀번호를 입력하세요:', cur);
  if (v === null) return;
  if (v === '') localStorage.removeItem(TOKEN_KEY);
  else          localStorage.setItem(TOKEN_KEY, v.trim());
  updateEditUI();
  if (getEditToken()) pushToServer();
  else setSyncStatus('readonly');
  render();   // 편집/읽기 상태 반영해 빈 행 추가/제거
}
function updateEditUI() {
  const has = !!getEditToken();
  document.body.classList.toggle('read-only', !has);
  const btn = document.getElementById('btnEdit');
  if (btn) {
    btn.textContent = has ? '🔓' : '🔒';
    btn.classList.toggle('active', has);
  }
  if (!has) setSyncStatus('readonly');
}

// ── 탭 / 미니탭 ─────────────────────────────────
function setActiveTab(t) {
  if (!['detail', 'grid', 'calendar', 'list'].includes(t)) return;
  activeTab = t;
  try { localStorage.setItem('school-timetable-tab', t); } catch (e) {}
  // 현재 activeChild 가 새 탭에서 유효한지 확인
  if (activeTab === 'detail' && activeChild === 'seungseung') {
    activeChild = 'seungho';
  }
  document.querySelectorAll('.top-tab').forEach(b => {
    const on = b.dataset.tab === t;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-panel').forEach(p => {
    p.classList.toggle('hidden', p.dataset.tab !== t);
  });
  // 미니탭(아이 선택)은 시간표/상세에서만
  const isChildTab = (t === 'grid' || t === 'detail');
  document.getElementById('miniTabs').classList.toggle('hidden', !isChildTab);
  if (isChildTab) renderMiniTabs();
  render();
}
function setActiveChild(c) {
  activeChild = c;
  renderMiniTabs();
  render();
}
function renderMiniTabs() {
  const bar = document.getElementById('miniTabs');
  const list = activeTab === 'grid'
    ? [...CHILDREN, { id: 'seungseung', label: '승승' }]
    : CHILDREN;
  bar.innerHTML = list.map(c =>
    `<button class="mini-tab${c.id === activeChild ? ' active' : ''}" data-child="${c.id}">${escapeAttr(c.label)}</button>`
  ).join('');
  bar.querySelectorAll('.mini-tab').forEach(b => {
    b.onclick = () => setActiveChild(b.dataset.child);
  });
}

// ── 렌더 ─────────────────────────────────────────
function render() {
  if (activeTab === 'detail') renderDetail();
  else if (activeTab === 'grid') renderGrid();
  else if (activeTab === 'calendar') renderCal();
  else if (activeTab === 'list') renderEventList();
}

function renderDetail() {
  const root = document.getElementById('detailList');
  root.innerHTML = '';
  const canEdit = !!getEditToken();
  for (const day of DAYS) {
    const dayEntries = state.entries
      .filter(e => e.child === activeChild && e.day === day.id)
      .slice()
      .sort((a, b) => (a.start || '').localeCompare(b.start || ''));

    // 기본 빈 행 1개 — 편집 모드일 때만 자동 노출
    const showEmptyDefault = canEdit && dayEntries.length === 0;

    const section = document.createElement('section');
    section.className = 'day-section';
    section.innerHTML = `
      <div class="day-header">
        <span class="day-name">${day.label}</span>
        <button class="btn-add" data-day="${day.id}">+ 추가</button>
      </div>
      <div class="day-rows" data-day="${day.id}"></div>
    `;
    const rowsEl = section.querySelector('.day-rows');
    if (showEmptyDefault) {
      rowsEl.appendChild(makeRowCard(null, day.id));
    } else {
      dayEntries.forEach(e => rowsEl.appendChild(makeRowCard(e, day.id)));
    }
    section.querySelector('.btn-add').onclick = () => {
      if (!canEdit) { alert('편집 모드에서만 추가할 수 있습니다.'); return; }
      addEntry(day.id);
    };
    root.appendChild(section);
  }
}

// entry === null 이면 미저장 빈 카드 (입력하면 저장됨)
function makeRowCard(entry, dayId) {
  const card = document.createElement('div');
  card.className = 'row-card';
  if (entry) card.dataset.id = entry.id;
  const e = entry || {
    kind: 'school', content: '', start: '', end: '',
    place: '', memo: '', color: PALETTE[0],
  };

  // 행 카드를 가로형으로 압축 — label/span 제거, placeholder + aria-label 로 흡수
  card.innerHTML = `
    <button class="row-delete" title="삭제" aria-label="삭제">×</button>
    <div class="row-row">
      <select class="f-kind" aria-label="항목">
        ${KINDS.map(k => `<option value="${k.id}"${k.id === e.kind ? ' selected' : ''}>${k.label}</option>`).join('')}
      </select>
      <input class="f-content" type="text" placeholder="내용" aria-label="내용" value="${escapeAttr(e.content)}" />
      <input class="f-start" type="time" aria-label="시작" value="${escapeAttr(e.start)}" />
      <input class="f-end" type="time" aria-label="종료" value="${escapeAttr(e.end)}" />
    </div>
    <div class="row-row">
      <input class="f-place" type="text" placeholder="장소 (선택)" aria-label="장소" value="${escapeAttr(e.place)}" />
      <input class="f-memo" type="text" placeholder="메모 (선택)" aria-label="메모" value="${escapeAttr(e.memo)}" />
    </div>
    <div class="palette" aria-label="색상">
      ${PALETTE.map(c =>
        `<button type="button" class="palette-swatch${c === e.color ? ' selected' : ''}" data-color="${c}" style="background:${c}" aria-label="${c}"></button>`
      ).join('')}
    </div>
  `;

  // 인풋 핸들러 — entry 가 null 이면 첫 입력 시 새로 만들고 id 부여
  const fields = ['kind', 'content', 'start', 'end', 'place', 'memo'];
  fields.forEach(f => {
    const sel = card.querySelector('.f-' + f);
    sel.addEventListener('input', () => {
      ensureEntry(card, dayId);
      const id = card.dataset.id;
      const target = findEntry(id);
      if (!target) return;
      target[f] = sel.value;
      target.updated_at = nowIso();
      saveLocal();
    });
    // select 도 change 만으로 트리거되는 환경 대비
    if (sel.tagName === 'SELECT') sel.addEventListener('change', () => {
      ensureEntry(card, dayId);
      const id = card.dataset.id;
      const target = findEntry(id);
      if (!target) return;
      target[f] = sel.value;
      target.updated_at = nowIso();
      saveLocal();
    });
  });

  card.querySelectorAll('.palette-swatch').forEach(s => {
    s.onclick = () => {
      ensureEntry(card, dayId);
      const id = card.dataset.id;
      const target = findEntry(id);
      if (!target) return;
      target.color = s.dataset.color;
      target.updated_at = nowIso();
      card.querySelectorAll('.palette-swatch').forEach(x => {
        x.classList.toggle('selected', x === s);
      });
      saveLocal();
    };
  });

  card.querySelector('.row-delete').onclick = () => {
    const id = card.dataset.id;
    if (!id) {
      // 미저장 카드 — 그냥 제거 또는 다시 빈 행으로
      card.remove();
      return;
    }
    if (!confirm('이 항목을 삭제할까요?')) return;
    state.entries = state.entries.filter(x => x.id !== id);
    saveLocal();
    renderDetail();
  };

  return card;
}

// 카드에 entry id 가 없으면 새로 만들어 dataset.id 채움
function ensureEntry(card, dayId) {
  if (card.dataset.id) return;
  const id = nextId();
  card.dataset.id = id;
  const ts = nowIso();
  state.entries.push({
    id, child: activeChild, day: dayId,
    kind: card.querySelector('.f-kind').value,
    content: '', start: '', end: '', place: '', memo: '',
    color: card.querySelector('.palette-swatch.selected')?.dataset.color || PALETTE[0],
    created_at: ts, updated_at: ts,
  });
}

function findEntry(id) { return state.entries.find(e => e.id === id); }

function addEntry(dayId) {
  const id = nextId();
  const ts = nowIso();
  state.entries.push({
    id, child: activeChild, day: dayId,
    kind: 'school', content: '', start: '', end: '',
    place: '', memo: '', color: PALETTE[0],
    created_at: ts, updated_at: ts,
  });
  saveLocal();
  renderDetail();
  // 새 카드 내용 input 에 포커스
  const card = document.querySelector(`.row-card[data-id="${id}"] .f-content`);
  if (card) card.focus();
}

// ── 시간표 격자 ─────────────────────────────────
function renderGrid() {
  const wrap = document.getElementById('gridWrap');
  wrap.innerHTML = '';

  const isSeungseung = activeChild === 'seungseung';
  // 보일 entry — start/end 가 유효한 것만
  const items = state.entries.filter(e => {
    if (!isSeungseung && e.child !== activeChild) return false;
    const s = parseTimeMin(e.start), x = parseTimeMin(e.end);
    return s != null && x != null && x > s && e.content && e.content.trim();
  });
  if (items.length === 0) {
    // 데이터는 있는데 필터에 걸려 안 보이는 경우엔 안내를 더 구체적으로
    const childEntries = state.entries.filter(e =>
      isSeungseung || e.child === activeChild
    );
    let msg;
    if (childEntries.length === 0) {
      msg = '아직 입력된 항목이 없습니다.<br/><small>상세 탭에서 항목을 추가하세요.</small>';
    } else {
      msg = `<strong>${childEntries.length}건</strong>의 항목이 있지만 시간표에 표시할 수 없습니다.<br/>` +
            `<small>상세 탭에서 <strong>내용·시작 시간·종료 시간</strong>을 모두 입력해야 시간표에 나타납니다.</small>`;
    }
    wrap.innerHTML = `<div class="grid-empty">${msg}</div>`;
    return;
  }

  // 한 칸 = 30분. 30분 단위가 아닌 시각은 15분 기준 스냅(분≤15 → 정시쪽, 분>15 → 30분쪽).
  // ※ 스냅은 '격자 배치'에만 적용 — 블록 라벨에는 실제 시작~종료 시간을 그대로 표시(혼동 방지).
  const SLOT = 30;
  const snap30 = m => { const r = ((m % SLOT) + SLOT) % SLOT; return r <= 15 ? m - r : m - r + SLOT; };
  let minT = Math.min(...items.map(e => snap30(parseTimeMin(e.start))));
  let maxT = Math.max(...items.map(e => snap30(parseTimeMin(e.end))));
  // 격자가 최소 4슬롯(=2시간)은 되도록 살짝 여유
  if (maxT - minT < SLOT * 4) maxT = minT + SLOT * 4;
  const slots = Math.round((maxT - minT) / SLOT);

  const tt = document.createElement('div');
  tt.className = 'timetable' + (isSeungseung ? ' seungseung' : '');
  // grid: 헤더 1행 + slots 행 (한 칸 40px — 줄바꿈 텍스트 수용)
  tt.style.gridTemplateRows = `auto repeat(${slots}, 40px)`;

  // ★ 모든 배경 칸을 '명시 배치'(grid-column/row 지정)로 둔다.
  //   entry 들이 명시 배치라, 배경 칸을 auto-placement 로 두면 grid 가 entry 를 먼저 놓고
  //   배경 칸이 그 주위로 밀려 흐르며 시간 열·격자가 어긋난다. 전부 명시하면 정렬이 고정됨.
  let html = '';
  // 헤더(1행): 좌상단 빈칸 + 요일
  html += `<div class="tt-cell tt-head" style="grid-column:1;grid-row:1"></div>`;
  DAYS.forEach((d, di) => {
    html += `<div class="tt-cell tt-head" style="grid-column:${di + 2};grid-row:1">${d.short}</div>`;
  });
  // 시간 라벨(1열) + 빈 셀 — 정시는 큰 굵은 글씨('08:00'), 30분은 작은 보조('30')
  for (let i = 0; i < slots; i++) {
    const row = i + 2;
    const t = minT + i * SLOT;
    const minOfHour = t % 60;
    let label = '', cls = '';
    if (minOfHour === 0)       { label = fmtMin(t); cls = ' hour'; }
    else if (minOfHour === 30) { label = '30';      cls = ' half'; }
    html += `<div class="tt-cell tt-time${cls}" style="grid-column:1;grid-row:${row}">${label}</div>`;
    for (let d = 0; d < DAYS.length; d++) {
      html += `<div class="tt-cell" data-day="${DAYS[d].id}" data-slot="${i}" style="grid-column:${d + 2};grid-row:${row}"></div>`;
    }
  }
  tt.innerHTML = html;
  wrap.appendChild(tt);

  // entry 배치 — 스냅된 30분 격자에 배치(라벨 텍스트는 실제 시각)
  for (const e of items) {
    const s = parseTimeMin(e.start);
    const x = parseTimeMin(e.end);
    const rowStart = Math.round((snap30(s) - minT) / SLOT) + 2;   // 헤더 행이 1
    const rowEnd   = Math.max(rowStart + 1, Math.round((snap30(x) - minT) / SLOT) + 2);
    const dayIdx = DAYS.findIndex(d => d.id === e.day);
    if (dayIdx < 0) continue;

    if (isSeungseung) {
      const div = document.createElement('div');
      div.className = 'tt-half';
      div.style.gridRow = `${rowStart} / ${rowEnd}`;
      // 좌=승호 (col 2), 우=승아 (col 3+)... 실제론 day col 안에서 좌/우.
      // 깔끔하게: 좌/우는 inset 으로 처리.
      div.style.gridColumn = `${dayIdx + 2}`;
      const side = e.child === 'seungho' ? 'left' : 'right';
      div.style.background = e.color;
      div.style[side === 'left' ? 'marginRight' : 'marginLeft'] = '50%';
      div.style[side === 'left' ? 'marginLeft' : 'marginRight'] = '2px';
      div.innerHTML = `<span class="tt-time-range">${escapeAttr(e.start)}~${escapeAttr(e.end)}</span>` +
        `<strong>${escapeAttr(e.content)}</strong>`;
      tt.appendChild(div);
    } else {
      const div = document.createElement('div');
      div.className = 'tt-entry';
      div.style.gridRow = `${rowStart} / ${rowEnd}`;
      div.style.gridColumn = `${dayIdx + 2}`;
      div.style.background = e.color;
      div.innerHTML = `<span class="tt-time-range">${escapeAttr(e.start)}~${escapeAttr(e.end)}</span>` +
        `<strong>${escapeAttr(e.content)}</strong>` +
        (e.memo ? `<small>${escapeAttr(e.memo)}</small>` : '');
      tt.appendChild(div);
    }
  }

  // 정시 가로선 — 컬러 entry 위에 오버레이로 그려 시간대 시각 기준 유지.
  // (i=0 은 헤더 바로 아래라 헤더 border 가 이미 처리 — 건너뜀)
  for (let i = 1; i < slots; i++) {
    const t = minT + i * SLOT;
    if (t % 60 !== 0) continue;
    const line = document.createElement('div');
    line.className = 'tt-hour-line';
    line.style.gridRow = String(i + 2);
    line.style.gridColumn = '1 / -1';
    tt.appendChild(line);
  }

  // 승승: 각 요일 컬럼 가운데 점선 — overlay 한 줄
  if (isSeungseung) {
    for (let d = 0; d < DAYS.length; d++) {
      const overlay = document.createElement('div');
      overlay.className = 'tt-divider';
      overlay.style.gridRow = `2 / ${slots + 2}`;
      overlay.style.gridColumn = `${d + 2}`;
      overlay.style.marginLeft = '50%';
      tt.appendChild(overlay);
    }
  }
}

// ════════ 달력 / 목록 (가족스케줄 통합) ════════
function canEdit() { return !!getEditToken(); }
function ymdLocal(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
function todayYmd() { return ymdLocal(new Date()); }
function memberById(id) { return state.members.find(m => m.id === id); }
function memberColor(id) { return memberById(id)?.color || '#cbd5e1'; }
function evUid() { return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function saveEvents() { saveLocal(); }   // 전체 state 를 서버에 푸시(기존 동기화 재사용)

function ddayLabel(date, today) {
  const diff = Math.round((new Date(date+'T00:00') - new Date(today+'T00:00')) / 86400000);
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  if (diff === -1) return '어제';
  return diff > 0 ? 'D-' + diff : 'D+' + (-diff);
}
function evTimeText(ev) {
  if (ev.endDate && ev.endDate !== ev.startDate) {
    const md = s => { const d = new Date(s+'T00:00'); return (d.getMonth()+1)+'/'+d.getDate(); };
    return md(ev.startDate) + '~' + md(ev.endDate);
  }
  if (ev.startTime) return ev.startTime + (ev.endTime ? '~'+ev.endTime : '');
  return '종일';
}
function evRowEl(ev) {
  const c = memberColor(ev.memberId), mem = memberById(ev.memberId);
  const row = document.createElement('div');
  row.className = 'ev-row'; row.style.borderLeftColor = c;
  row.innerHTML =
    '<span class="ev-time">' + escapeAttr(evTimeText(ev)) + '</span>' +
    '<div class="ev-body"><div class="ev-name">' + escapeAttr(ev.title || '(제목 없음)') + '</div>' +
      (ev.memo ? '<div class="ev-memo">' + escapeAttr(ev.memo) + '</div>' : '') + '</div>' +
    (mem ? '<span class="ev-who" style="background:'+c+'">' + escapeAttr(mem.name) + '</span>' : '');
  row.onclick = () => openEvt(ev);
  return row;
}
function eventsOnDate(ds) {
  return state.events
    .filter(ev => ev.startDate && ev.startDate <= ds && (ev.endDate || ev.startDate) >= ds)
    .sort((a,b) => (a.startTime||'99').localeCompare(b.startTime||'99'));
}

function renderCal() {
  document.getElementById('calTitle').textContent = calView.getFullYear() + '.' + (calView.getMonth()+1);
  const wk = document.getElementById('calWeek');
  if (!wk.children.length) wk.innerHTML = WD.map((d,i)=>'<div class="'+(i===0?'sun':i===6?'sat':'')+'">'+d+'</div>').join('');
  renderCalGrid();
  renderCalDay();
}
function renderCalGrid() {
  const grid = document.getElementById('calGrid'); grid.innerHTML = '';
  const y = calView.getFullYear(), m = calView.getMonth();
  const start = new Date(y, m, 1); start.setDate(1 - start.getDay());
  const today = todayYmd();
  for (let i=0;i<42;i++) {
    const d = new Date(start); d.setDate(start.getDate()+i);
    const ds = ymdLocal(d), dow = d.getDay();
    const cell = document.createElement('div');
    cell.className = 'cal-cell' + (d.getMonth()!==m?' oth':'') + (dow===0?' sun':dow===6?' sat':'')
      + (ds===today?' today':'') + (ds===calSel?' sel':'');
    cell.innerHTML = '<span class="cdn">'+d.getDate()+'</span>';
    const evs = eventsOnDate(ds);
    evs.slice(0,3).forEach(ev => {
      const chip = document.createElement('div');
      chip.className = 'cal-chip'; chip.style.background = memberColor(ev.memberId);
      const showTime = ev.startTime && ev.startDate === ds && (!ev.endDate || ev.endDate === ev.startDate);
      chip.textContent = (showTime ? ev.startTime+' ' : '') + (ev.title || '');
      cell.appendChild(chip);
    });
    if (evs.length>3) { const mo=document.createElement('div'); mo.className='cal-more'; mo.textContent='+'+(evs.length-3); cell.appendChild(mo); }
    cell.onclick = () => { calSel = ds; renderCal(); };
    grid.appendChild(cell);
  }
}
function renderCalDay() {
  const panel = document.getElementById('calDay');
  if (!calSel) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden'); panel.innerHTML = '';
  const d = new Date(calSel+'T00:00');
  const head = document.createElement('div'); head.className = 'cal-day-head';
  head.innerHTML = '<strong>'+(d.getMonth()+1)+'월 '+d.getDate()+'일 ('+WD[d.getDay()]+')</strong><span class="cdg"></span>';
  const add = document.createElement('button'); add.className='cal-day-add'; add.textContent='＋ 일정 추가';
  add.onclick = () => openEvt(null); head.appendChild(add); panel.appendChild(head);
  const evs = eventsOnDate(calSel);
  if (!evs.length) { const e=document.createElement('div'); e.className='ev-empty'; e.textContent='이 날 일정이 없어요.'; panel.appendChild(e); return; }
  const wrap = document.createElement('div'); wrap.className='ev-group';
  evs.forEach(ev => wrap.appendChild(evRowEl(ev)));
  panel.appendChild(wrap);
}

function renderEventList() {
  const box = document.getElementById('listView'); box.innerHTML = '';
  if (canEdit()) {
    const add = document.createElement('button'); add.className='ev-add-top'; add.textContent='＋ 일정 추가';
    add.onclick = () => openEvt(null); box.appendChild(add);
  }
  const evs = state.events.slice().sort((a,b)=> (a.startDate+(a.startTime||'99')).localeCompare(b.startDate+(b.startTime||'99')));
  if (!evs.length) { box.insertAdjacentHTML('beforeend','<div class="ev-empty">등록된 일정이 없어요.<br>＋ 일정 추가로 만들어 보세요.</div>'); return; }
  const today = todayYmd();
  const upcoming = evs.filter(e => (e.endDate||e.startDate) >= today);
  const past = evs.filter(e => (e.endDate||e.startDate) < today);
  if (upcoming.length) renderEvGroups(box, upcoming, today);
  else box.insertAdjacentHTML('beforeend','<div class="ev-empty">다가오는 일정이 없어요.</div>');
  if (past.length) {
    const btn = document.createElement('button'); btn.className='ev-past-btn';
    btn.textContent = evShowPast ? '▲ 지난 일정 '+past.length+'개 숨기기' : '▼ 지난 일정 '+past.length+'개 보기';
    btn.onclick = () => { evShowPast = !evShowPast; renderEventList(); };
    box.appendChild(btn);
    if (evShowPast) renderEvGroups(box, past.slice().reverse(), today);
  }
}
function renderEvGroups(box, list, today) {
  let cur=null, group=null;
  for (const ev of list) {
    if (ev.startDate !== cur) {
      cur = ev.startDate;
      const d = new Date(ev.startDate+'T00:00');
      const h = document.createElement('div');
      h.className = 'ev-date-h' + (ev.startDate===today?' todayh':'');
      h.innerHTML = (d.getMonth()+1)+'월 '+d.getDate()+'일 ('+WD[d.getDay()]+')<span class="ev-dday">'+ddayLabel(ev.startDate,today)+'</span>';
      box.appendChild(h);
      group = document.createElement('div'); group.className='ev-group'; box.appendChild(group);
    }
    group.appendChild(evRowEl(ev));
  }
}

// ── 일정 모달 ──
function openEvt(ev) {
  if (ev === null && !canEdit()) { alert('편집 모드(🔓)에서만 추가할 수 있습니다.'); return; }
  editingEvId = ev ? ev.id : null;
  const ro = !canEdit();
  document.getElementById('evModalTitle').textContent = ev ? (ro ? '일정 보기' : '일정 수정') : '일정 추가';
  const def = calSel || todayYmd();
  document.getElementById('evTitleIn').value = ev ? (ev.title||'') : '';
  document.getElementById('evStartDate').value = ev ? ev.startDate : def;
  document.getElementById('evStartTime').value = ev ? (ev.startTime||'') : '';
  document.getElementById('evEndDate').value = ev ? (ev.endDate||ev.startDate) : def;
  document.getElementById('evEndTime').value = ev ? (ev.endTime||'') : '';
  document.getElementById('evMemoIn').value = ev ? (ev.memo||'') : '';
  evMemberSel = ev ? (ev.memberId||null) : null;
  renderEvMemberChips();
  ['evTitleIn','evStartDate','evStartTime','evEndDate','evEndTime','evMemoIn'].forEach(id => document.getElementById(id).disabled = ro);
  document.getElementById('evSaveBtn').classList.toggle('hidden', ro);
  document.getElementById('evDeleteBtn').classList.toggle('hidden', !ev || ro);
  document.getElementById('evModal').classList.remove('hidden');
}
function renderEvMemberChips() {
  const box = document.getElementById('evMemberChips'); box.innerHTML='';
  const ro = !canEdit();
  const mk = (id,name,color) => {
    const b = document.createElement('button'); b.className='ev-chip'; b.textContent=name;
    if (evMemberSel===id) { b.style.background = color||'#e5e7eb'; b.style.borderColor = color||'#e5e7eb'; }
    b.onclick = () => { if(ro) return; evMemberSel = (evMemberSel===id?null:id); renderEvMemberChips(); };
    box.appendChild(b);
  };
  mk(null,'공용',null);
  state.members.forEach(m => mk(m.id, m.name, m.color));
}
function saveEvt() {
  if (!canEdit()) return;
  const title = document.getElementById('evTitleIn').value.trim();
  if (!title) { alert('제목을 입력하세요.'); return; }
  let sd = document.getElementById('evStartDate').value || todayYmd();
  let ed = document.getElementById('evEndDate').value || sd;
  if (ed < sd) ed = sd;
  const ts = nowIso();
  const data = { title, startDate:sd, endDate:ed,
    startTime:document.getElementById('evStartTime').value||'',
    endTime:document.getElementById('evEndTime').value||'',
    memberId:evMemberSel, memo:document.getElementById('evMemoIn').value.trim() };
  const ev = editingEvId ? state.events.find(e=>e.id===editingEvId) : null;
  if (ev) Object.assign(ev, data, { updated_at:ts });
  else state.events.push(Object.assign({ id:evUid(), created_at:ts, updated_at:ts }, data));
  calSel = sd;
  document.getElementById('evModal').classList.add('hidden');
  saveEvents(); render();
}
function deleteEvt() {
  if (!canEdit() || !editingEvId) return;
  if (!confirm('이 일정을 삭제할까요?')) return;
  state.events = state.events.filter(e => e.id !== editingEvId);
  document.getElementById('evModal').classList.add('hidden');
  saveEvents(); render();
}

// ── 구성원 모달 ──
function openMembers() {
  if (!canEdit()) { alert('편집 모드(🔓)에서만 구성원을 관리할 수 있습니다.'); return; }
  renderMembers(); document.getElementById('memModal').classList.remove('hidden');
}
function renderMembers() {
  const box = document.getElementById('memList'); box.innerHTML='';
  if (!state.members.length) box.innerHTML = '<div class="ev-empty" style="padding:14px">아직 구성원이 없어요. 아래에서 추가하세요.</div>';
  state.members.forEach(m => {
    const row = document.createElement('div'); row.className='mem-row2';
    row.innerHTML = '<span class="mem-dot2" style="background:'+m.color+'"></span><span class="mn">'+escapeAttr(m.name)+'</span><button class="del">삭제</button>';
    row.querySelector('.del').onclick = () => {
      if (!confirm("'"+m.name+"' 삭제?")) return;
      state.members = state.members.filter(x=>x.id!==m.id);
      saveEvents(); renderMembers(); render();
    };
    box.appendChild(row);
  });
}
function addMember() {
  if (!canEdit()) return;
  const name = document.getElementById('memNameIn').value.trim();
  if (!name) return;
  const color = document.getElementById('memColorIn').value || PALETTE[state.members.length%PALETTE.length];
  state.members.push({ id:evUid(), name, color });
  document.getElementById('memNameIn').value='';
  saveEvents(); renderMembers(); renderEvMemberChips();
}

// ── 부트 ─────────────────────────────────────────
async function bootstrap() {
  // 탭 클릭
  document.querySelectorAll('.top-tab').forEach(b => {
    b.onclick = () => setActiveTab(b.dataset.tab);
  });
  // 편집 토큰
  document.getElementById('btnEdit').onclick = promptEditToken;
  // 저장 FAB
  document.getElementById('btnSave').onclick = manualSave;

  // 달력/목록(가족스케줄)
  document.getElementById('calPrev').onclick = () => { calView.setMonth(calView.getMonth()-1); renderCal(); };
  document.getElementById('calNext').onclick = () => { calView.setMonth(calView.getMonth()+1); renderCal(); };
  document.getElementById('calToday').onclick = () => { const t=new Date(); calView=new Date(t.getFullYear(),t.getMonth(),1); calSel=todayYmd(); renderCal(); };
  document.getElementById('calMembers').onclick = openMembers;
  document.getElementById('evClose').onclick = () => document.getElementById('evModal').classList.add('hidden');
  document.getElementById('evSaveBtn').onclick = saveEvt;
  document.getElementById('evDeleteBtn').onclick = deleteEvt;
  document.getElementById('memClose').onclick = () => document.getElementById('memModal').classList.add('hidden');
  document.getElementById('memAddBtn').onclick = addMember;
  document.querySelectorAll('.ev-overlay').forEach(ov => ov.addEventListener('click', e => { if (e.target===ov) ov.classList.add('hidden'); }));

  // 초기 데이터 로드
  state = await loadInitial();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  updateEditUI();
  // 마지막 본 탭 복원(없으면 시간표)
  const savedTab = localStorage.getItem('school-timetable-tab');
  setActiveTab(['grid', 'detail', 'calendar', 'list'].includes(savedTab) ? savedTab : 'grid');
}

document.addEventListener('DOMContentLoaded', bootstrap);
