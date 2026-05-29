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

function DEFAULT_STATE() { return { version: 1, entries: [] }; }

let state = DEFAULT_STATE();
let activeTab = 'detail';        // 'detail' | 'grid'
let activeChild = 'seungho';     // 'seungho' | 'seunga' | 'seungseung' (grid 전용)

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
  if (t !== 'detail' && t !== 'grid') return;
  activeTab = t;
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
  renderMiniTabs();
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
  else                        renderGrid();
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

  // 시간 범위 — 15분 단위 스냅
  const SLOT = 15;
  let minT = Math.min(...items.map(e => Math.floor(parseTimeMin(e.start) / SLOT) * SLOT));
  let maxT = Math.max(...items.map(e => Math.ceil( parseTimeMin(e.end)   / SLOT) * SLOT));
  // 격자가 최소 4슬롯은 되도록 살짝 여유
  if (maxT - minT < SLOT * 4) maxT = minT + SLOT * 4;
  const slots = Math.round((maxT - minT) / SLOT);

  const tt = document.createElement('div');
  tt.className = 'timetable';
  // grid: 헤더 1행 + slots 행
  tt.style.gridTemplateRows = `auto repeat(${slots}, 28px)`;

  // 헤더: 빈칸 + 요일
  tt.innerHTML = `<div class="tt-cell tt-head"></div>` +
    DAYS.map(d => `<div class="tt-cell tt-head">${d.short}</div>`).join('');

  // 시간 라벨 + 빈 셀 — 정시는 큰 굵은 글씨('08:00'), 30분은 작은 보조('30')
  for (let i = 0; i < slots; i++) {
    const t = minT + i * SLOT;
    const minOfHour = t % 60;
    let label = '', cls = '';
    if (minOfHour === 0)       { label = fmtMin(t); cls = ' hour'; }
    else if (minOfHour === 30) { label = '30';      cls = ' half'; }
    tt.innerHTML += `<div class="tt-cell tt-time${cls}">${label}</div>`;
    for (let d = 0; d < DAYS.length; d++) {
      tt.innerHTML += `<div class="tt-cell" data-day="${DAYS[d].id}" data-slot="${i}"></div>`;
    }
  }
  wrap.appendChild(tt);

  // entry 배치
  const SLOT_PX = 28;
  for (const e of items) {
    const s = parseTimeMin(e.start);
    const x = parseTimeMin(e.end);
    const rowStart = Math.round((s - minT) / SLOT) + 2;   // 헤더 행이 1
    const rowEnd   = Math.round((x - minT) / SLOT) + 2;
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

  // 초기 데이터 로드
  state = await loadInitial();
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  updateEditUI();
  renderMiniTabs();
  render();
}

document.addEventListener('DOMContentLoaded', bootstrap);
