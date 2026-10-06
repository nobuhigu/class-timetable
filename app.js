'use strict';

const STORAGE_KEY = 'class-timetable-v1';
const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
const ABSENCE_WARN = 3; // この回数以上の欠席で警告表示
const URGENT_MS = 24 * 60 * 60 * 1000; // 締め切りまでこれ未満なら強調

const STATUS = { present: '出席', late: '遅刻', absent: '欠席', excused: '公欠' };
const CAMPUSES = ['駒場', '本郷'];

// 設定画面の「時間のプリセット」。先頭が新しい学期の初期値
const PERIOD_PRESETS = {
  // 東京大学 標準の105分授業（教養学部の時間割資料より）
  utokyo: {
    label: '東京大学（105分授業）',
    periods: [
      { start: '08:30', end: '10:15' },
      { start: '10:25', end: '12:10' },
      { start: '13:00', end: '14:45' },
      { start: '14:55', end: '16:40' },
      { start: '16:50', end: '18:35' },
      { start: '18:45', end: '20:30' },
    ],
  },
  general90: {
    label: '一般的な90分授業',
    periods: [
      { start: '09:00', end: '10:30' },
      { start: '10:40', end: '12:10' },
      { start: '13:00', end: '14:30' },
      { start: '14:40', end: '16:10' },
      { start: '16:20', end: '17:50' },
      { start: '18:00', end: '19:30' },
    ],
  },
};
const DEFAULT_PERIODS = PERIOD_PRESETS.utokyo.periods;

// 東大で90分授業になる場合の時間（105分の枠の中に収まる）
const UTOKYO_90 = [
  { start: '08:30', end: '10:00' },
  { start: '10:25', end: '11:55' },
  { start: '13:15', end: '14:45' },
  { start: '15:10', end: '16:40' },
  { start: '17:05', end: '18:35' },
  { start: '19:00', end: '20:30' },
];

const $ = (sel) => document.querySelector(sel);

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
}

// ---------- データ ----------

function newTerm(name, base) {
  return {
    id: crypto.randomUUID(),
    name,
    days: base ? [...base.days] : [1, 2, 3, 4, 5],
    periods: base ? base.periods.map((p) => ({ ...p })) : DEFAULT_PERIODS.map((p) => ({ ...p })),
    classes: {}, // key: "曜日-時限index"
  };
}

function emptyClass() {
  return {
    name: '', campus: '', room: '', teacher: '', zoomUrl: '', utolUrl: '', color: '#4f8cff', memo: '',
    start: '', end: '', assignments: [], attendance: [],
  };
}

// 古い形式のデータを現在の形式にそろえる
function normalize(data) {
  for (const t of data.terms) {
    t.classes ??= {};
    for (const c of Object.values(t.classes)) {
      c.zoomUrl ??= '';
      c.utolUrl ??= '';
      c.campus ??= '';
      c.memo ??= '';
      c.start ??= ''; // 空なら時限の時間どおり
      c.end ??= '';
      if (!Array.isArray(c.assignments)) c.assignments = [];
      if (!Array.isArray(c.attendance)) {
        // 旧バージョンの「欠席回数」は日付不明の欠席記録として引き継ぐ
        const n = Math.max(0, Number(c.absences) || 0);
        c.attendance = Array.from({ length: n }, () => ({ date: '', status: 'absent' }));
      }
      delete c.absences;
    }
  }
  if (!data.terms.some((t) => t.id === data.currentTermId)) data.currentTermId = data.terms[0].id;
  return data;
}

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (data && Array.isArray(data.terms) && data.terms.length) return normalize(data);
  } catch { /* 壊れたデータは初期化 */ }
  const term = newTerm(defaultTermName());
  return { currentTermId: term.id, terms: [term] };
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function defaultTermName() {
  const d = new Date();
  return `${d.getFullYear()}年度 ${d.getMonth() >= 3 && d.getMonth() <= 8 ? '前期' : '後期'}`;
}

let state = load();

function term() {
  return state.terms.find((t) => t.id === state.currentTermId) ?? state.terms[0];
}

function slotLabel(key) {
  const [day, i] = key.split('-').map(Number);
  return `${DAY_NAMES[day]}${i + 1}限`;
}

// ---------- 時間ユーティリティ ----------

const pad = (n) => String(n).padStart(2, '0');

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function fromMinutes(m) {
  return `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
}

// toISOString はUTCなので日本時間の朝にずれる。ローカル日付で作る
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function formatDate(ymd) {
  if (!ymd) return '日付不明';
  const d = new Date(`${ymd}T00:00`);
  return `${d.getMonth() + 1}/${d.getDate()}(${DAY_NAMES[d.getDay()]})`;
}

const minutesBetween = (p) => toMinutes(p.end) - toMinutes(p.start);

// 授業ごとに時間を変えていればそれを、なければ時限の時間を使う
function classTime(t, key) {
  const c = t.classes[key];
  if (c?.start && c?.end) return { start: c.start, end: c.end };
  return t.periods[Number(key.split('-')[1])];
}

// その時限で90分授業にしたときの時間
function ninetyMinutes(p, i) {
  const u = PERIOD_PRESETS.utokyo.periods[i];
  if (u && u.start === p.start && u.end === p.end) return UTOKYO_90[i];
  return { start: p.start, end: fromMinutes(toMinutes(p.start) + 90) };
}

function isDuring(time, minutes) {
  return minutes >= toMinutes(time.start) && minutes < toMinutes(time.end);
}

function nowInfo() {
  const d = new Date();
  return { day: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() };
}

// ---------- 課題・出欠・Zoom ----------

function dueInfo(a) {
  if (!a.due) return { label: '期限なし', level: '' };
  const d = new Date(a.due);
  const label = `${d.getMonth() + 1}/${d.getDate()}(${DAY_NAMES[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (a.done) return { label, level: '' };
  const diff = d - Date.now();
  if (diff < 0) return { label: `${label} 期限切れ`, level: 'over' };
  const rest = diff < 60 * 60 * 1000 ? `あと${Math.ceil(diff / 60000)}分`
    : diff < URGENT_MS ? `あと${Math.floor(diff / 3600000)}時間`
    : `あと${Math.round((new Date(localDate(d)) - new Date(localDate())) / URGENT_MS)}日`; // 暦の日数で数える
  return { label: `${label}（${rest}）`, level: diff < URGENT_MS ? 'warn' : '' };
}

function isUrgent(a) {
  return !a.done && a.due && new Date(a.due) - Date.now() < URGENT_MS;
}

// 未完了→締め切りが近い順（期限なしは後ろ）
function compareTasks(a, b) {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (!a.due !== !b.due) return a.due ? -1 : 1;
  return (a.due || '').localeCompare(b.due || '');
}

function attendanceCounts(c) {
  const counts = { present: 0, late: 0, absent: 0, excused: 0 };
  for (const r of c.attendance) counts[r.status]++;
  return counts;
}

// 同じ日付の記録があれば上書き
function setAttendance(c, date, status) {
  const rec = date && c.attendance.find((r) => r.date === date);
  if (rec) rec.status = status;
  else c.attendance.push({ date, status });
}

// javascript: などを開かないよう、http(s) と Zoom アプリのURLだけ許可
function safeUrl(url) {
  let u = (url || '').trim();
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = `https://${u}`;
  return /^(https?|zoommtg|zoomus):/i.test(u) ? u : '';
}

// https://xxx.zoom.us/j/123?pwd=abc → zoommtg://xxx.zoom.us/join?action=join&confno=123&pwd=abc
// 変換できない形式（/my/ の個人URLなど）は null
function zoomAppUrl(webUrl) {
  if (/^(zoommtg|zoomus):/i.test(webUrl)) return webUrl;
  let u;
  try { u = new URL(webUrl); } catch { return null; }
  if (!/(^|\.)zoom\.us$/i.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/j\/(\d+)/);
  if (!m) return null;
  const params = new URLSearchParams({ action: 'join', confno: m[1] });
  const pwd = u.searchParams.get('pwd');
  if (pwd) params.set('pwd', pwd);
  return `zoommtg://${u.hostname}/join?${params}`;
}

// Zoomアプリを直接起動する。アプリが無いときのためにブラウザで開く案内も出す
function launchZoom(url) {
  const web = safeUrl(url);
  if (!web) return;
  const app = zoomAppUrl(web);
  if (!app) {
    window.open(web, '_blank', 'noopener');
    return;
  }
  location.href = app;
  if (/^https?:/i.test(web)) showToast('Zoomが起動しない場合は', 'ブラウザで開く', web);
}

const ZOOM_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 7.5A2.5 2.5 0 0 1 5.5 5h8A2.5 2.5 0 0 1 16 7.5v1.7l4.2-2.8a.5.5 0 0 1 .8.4v10.4a.5.5 0 0 1-.8.4L16 14.8v1.7a2.5 2.5 0 0 1-2.5 2.5h-8A2.5 2.5 0 0 1 3 16.5z"/></svg>';

const UTOL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4.5A1.5 1.5 0 0 1 5.5 3H11v16H5.5A1.5 1.5 0 0 1 4 17.5zM13 3h5.5A1.5 1.5 0 0 1 20 4.5v13a1.5 1.5 0 0 1-1.5 1.5H13zM6 21h12v-1H6z"/></svg>';

const LINK_KINDS = {
  zoom: {
    icon: ZOOM_ICON,
    open: launchZoom,
    ok: 'Zoomアプリで参加',
    ng: 'Zoom URLが登録されていません',
  },
  utol: {
    icon: UTOL_ICON,
    open: (url) => window.open(url, '_blank', 'noopener'),
    ok: 'UTOLの授業ページを開く',
    ng: 'UTOLのリンクが登録されていません',
  },
};

// URLが無いときは灰色で押せないボタンになる
function linkButton(kind, url, label, className = `link-btn ${kind}`) {
  const b = el('button', className);
  b.type = 'button';
  b.innerHTML = LINK_KINDS[kind].icon;
  if (label) b.appendChild(el('span', '', label));
  setLinkButton(b, kind, url);
  b.addEventListener('click', (e) => {
    e.stopPropagation(); // マスのクリック（編集画面を開く）を止める
    LINK_KINDS[kind].open(b.dataset.url);
  });
  return b;
}

function setLinkButton(b, kind, url) {
  const ok = safeUrl(url);
  b.disabled = !ok;
  b.dataset.url = ok;
  b.title = ok ? LINK_KINDS[kind].ok : LINK_KINDS[kind].ng;
}

let toastTimer = null;
function showToast(text, linkText, href) {
  const t = $('#toast');
  // モーダル表示中はダイアログが最前面になるので、その中に移して見えるようにする
  (document.querySelector('dialog[open]') ?? document.body).appendChild(t);
  t.innerHTML = '';
  t.appendChild(el('span', '', text));
  if (linkText) {
    const a = el('a', '', linkText);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    t.appendChild(a);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 8000);
}

// ---------- 描画 ----------

function render() {
  renderTermSelect();
  renderTable();
  renderNow();
  renderTaskCount();
}

function renderTermSelect() {
  const sel = $('#termSelect');
  sel.innerHTML = '';
  for (const t of state.terms) {
    sel.add(new Option(t.name, t.id, false, t.id === term().id));
  }
}

function renderTable() {
  const t = term();
  const { day: today, minutes } = nowInfo();
  const table = $('#timetable');
  table.innerHTML = '';

  const head = table.createTHead().insertRow();
  head.appendChild(el('th'));
  for (const day of t.days) {
    const th = el('th', day === today ? 'today' : '', DAY_NAMES[day]);
    head.appendChild(th);
  }

  const body = table.createTBody();
  t.periods.forEach((p, i) => {
    const row = body.insertRow();
    const th = el('th', 'period');
    th.innerHTML = `<span class="num">${i + 1}</span><span class="time">${p.start}<br>〜${p.end}</span>`;
    row.appendChild(th);

    for (const day of t.days) {
      const td = row.insertCell();
      const key = `${day}-${i}`;
      if (day === today) td.classList.add('today');
      if (day === today && isDuring(classTime(t, key), minutes)) td.classList.add('current');
      td.addEventListener('click', () => openClassDialog(day, i));

      const c = t.classes[key];
      if (c) td.appendChild(classCell(c));
    }
  });
}

function classCell(c) {
  const div = el('div', 'cls');
  div.style.setProperty('--c', c.color);
  // 狭いマスなので、URLがある授業だけアイコンのボタンを出す
  if (safeUrl(c.zoomUrl)) div.appendChild(linkButton('zoom', c.zoomUrl, '', 'zoom-icon'));
  div.appendChild(el('div', 'name', c.name));

  const place = [c.campus, c.room].filter(Boolean).join(' ');
  const sub = [place, c.teacher].filter(Boolean).join(' / ');
  if (sub) div.appendChild(el('div', 'sub', sub));

  const badges = el('div', 'badges');
  if (c.start && c.end) badges.appendChild(badge(`${minutesBetween(c)}分`, false, 'length'));
  const pending = c.assignments.filter((a) => !a.done);
  if (pending.length) {
    badges.appendChild(badge(`課題${pending.length}`, pending.some(isUrgent)));
  }
  const absent = attendanceCounts(c).absent;
  if (absent > 0) badges.appendChild(badge(`欠${absent}`, absent >= ABSENCE_WARN));
  if (c.memo) badges.appendChild(badge('メモ', false, 'minor'));
  div.appendChild(badges);
  return div;
}

function badge(text, warn = false, extra = '') {
  return el('span', ['badge', warn && 'warn', extra].filter(Boolean).join(' '), text);
}

function renderTaskCount() {
  let pending = 0;
  let urgent = false;
  for (const c of Object.values(term().classes)) {
    for (const a of c.assignments) {
      if (a.done) continue;
      pending++;
      urgent ||= isUrgent(a);
    }
  }
  const count = $('#tasksCount');
  count.textContent = pending || '';
  count.classList.toggle('warn', urgent);
}

// 「今の授業」「次の授業」と締め切りが近い課題を表示
function renderNow() {
  const t = term();
  const { day, minutes } = nowInfo();
  const box = $('#now');
  box.innerHTML = '';

  const urgent = Object.values(t.classes).flatMap((c) => c.assignments.filter(isUrgent));
  if (urgent.length) {
    const line = el('div', 'now-line urgent');
    line.appendChild(el('span', '', `締め切り24時間以内の課題が${urgent.length}件あります`));
    const btn = el('button', '', '確認');
    btn.addEventListener('click', openTasksDialog);
    line.appendChild(btn);
    box.appendChild(line);
  }

  if (!t.days.includes(day)) return;

  // p は授業ごとの時間を反映したもの
  const todays = t.periods
    .map((_, i) => ({ i, c: t.classes[`${day}-${i}`], p: classTime(t, `${day}-${i}`) }))
    .filter((x) => x.c);
  if (!todays.length) {
    box.appendChild(el('div', 'now-line', '今日は授業がありません'));
    return;
  }

  const current = todays.find(({ p }) => isDuring(p, minutes));
  const next = todays.find(({ p }) => toMinutes(p.start) > minutes);
  const desc = ({ p, i, c }) => {
    const place = [c.campus, c.room].filter(Boolean).join(' ');
    return `${i + 1}限 ${c.name}${place ? `（${place}）` : ''} ${p.start}〜${p.end}`;
  };

  if (current) {
    const line = el('div', 'now-line');
    line.appendChild(el('strong', '', '授業中'));
    line.appendChild(el('span', '', desc(current)));
    line.appendChild(linkButton('zoom', current.c.zoomUrl, 'Zoom'));
    line.appendChild(linkButton('utol', current.c.utolUrl, 'UTOL'));
    line.appendChild(quickAttendance(current.c));
    box.appendChild(line);
  }
  if (next) {
    const line = el('div', 'now-line');
    line.appendChild(el('strong', '', '次'));
    line.appendChild(el('span', '', `${desc(next)}（あと${toMinutes(next.p.start) - minutes}分）`));
    line.appendChild(linkButton('zoom', next.c.zoomUrl, 'Zoom'));
    line.appendChild(linkButton('utol', next.c.utolUrl, 'UTOL'));
    // 直前の授業とキャンパスが違えば移動を知らせる
    const prev = todays.filter(({ p }) => toMinutes(p.end) <= toMinutes(next.p.start)).pop();
    if (prev?.c.campus && next.c.campus && prev.c.campus !== next.c.campus) {
      line.appendChild(el('span', 'move-warn', `キャンパス移動あり（${prev.c.campus}→${next.c.campus}）`));
    }
    box.appendChild(line);
  }
  if (!current && !next) box.appendChild(el('div', 'now-line', '今日の授業は終わりました'));
}

// 授業中の授業の出欠をワンタップで記録（すぐ保存）
function quickAttendance(c) {
  const wrap = el('span', 'status-buttons small');
  const today = localDate();
  const rec = c.attendance.find((r) => r.date === today);
  for (const status of ['present', 'late', 'absent']) {
    const b = el('button', `status-${status}`, STATUS[status]);
    if (rec?.status === status) b.classList.add('selected');
    b.addEventListener('click', () => {
      setAttendance(c, today, status);
      save();
      render();
    });
    wrap.appendChild(b);
  }
  return wrap;
}

// ---------- 授業編集 ----------

const classDialog = $('#classDialog');
const classForm = $('#classForm');
let editingKey = null;
let draft = null; // 保存するまではこのコピーを編集する

function switchTab(name) {
  classForm.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  classForm.querySelectorAll('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
}

classForm.querySelectorAll('[data-tab]').forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});
for (const name of CAMPUSES) {
  const label = el('label');
  const radio = el('input');
  radio.type = 'radio';
  radio.name = 'campus';
  radio.value = name;
  label.append(radio, el('span', '', name));
  $('#campusChoices').appendChild(label);
}

// 他のタブを開いたまま授業名が空で保存したとき、入力欄を見えるようにする
classForm.courseName.addEventListener('invalid', () => switchTab('info'));

function openClassDialog(day, periodIndex) {
  editingKey = `${day}-${periodIndex}`;
  const c = term().classes[editingKey];
  draft = structuredClone(c ?? emptyClass());

  $('#classDialogTitle').textContent = `${DAY_NAMES[day]}曜 ${periodIndex + 1}限`;
  classForm.courseName.value = draft.name;
  classForm.teacher.value = draft.teacher;
  classForm.room.value = draft.room;
  classForm.zoomUrl.value = draft.zoomUrl;
  classForm.utolUrl.value = draft.utolUrl;
  classForm.campus.value = draft.campus;
  classForm.color.value = draft.color;
  classForm.memo.value = draft.memo;
  updateLinkButtons();
  setupTimeOptions(periodIndex);

  $('#taskTitle').value = '';
  $('#taskDue').value = '';
  $('#attendDate').value = localDate();
  renderDraftTasks();
  renderDraftAttendance();

  $('#deleteClassBtn').hidden = !c;
  switchTab('info');
  classDialog.returnValue = '';
  classDialog.showModal();
}

// ダイアログ上部のZoom・UTOLボタンは入力中のURLに合わせて押せる／押せないを切り替える
const dialogZoomBtn = linkButton('zoom', '', 'Zoomで参加');
const dialogUtolBtn = linkButton('utol', '', 'UTOL');
$('#classDialogLinks').append(dialogZoomBtn, dialogUtolBtn);

function updateLinkButtons() {
  setLinkButton(dialogZoomBtn, 'zoom', classForm.zoomUrl.value);
  setLinkButton(dialogUtolBtn, 'utol', classForm.utolUrl.value);
}
classForm.zoomUrl.addEventListener('input', updateLinkButtons);
classForm.utolUrl.addEventListener('input', updateLinkButtons);

// --- 授業時間（時限どおり／90分／時刻指定） ---

let timeChoices = {}; // 選択肢ごとの時間。custom は入力欄から読む

function setupTimeOptions(periodIndex) {
  const p = term().periods[periodIndex];
  const n90 = ninetyMinutes(p, periodIndex);
  timeChoices = { period: p, 90: n90 };

  const sel = classForm.timeMode;
  sel.innerHTML = '';
  sel.add(new Option(`${minutesBetween(p)}分（${p.start}〜${p.end}）`, 'period'));
  if (minutesBetween(p) !== 90) sel.add(new Option(`90分（${n90.start}〜${n90.end}）`, '90'));
  sel.add(new Option('時刻を指定', 'custom'));

  const same = (a) => a && a.start === draft.start && a.end === draft.end;
  sel.value = !draft.start ? 'period' : same(n90) && minutesBetween(p) !== 90 ? '90' : same(p) ? 'period' : 'custom';
  classForm.startTime.value = draft.start || p.start;
  classForm.endTime.value = draft.end || p.end;
  updateCustomTime();
}

function updateCustomTime() {
  const custom = classForm.timeMode.value === 'custom';
  $('#customTime').hidden = !custom;
  classForm.startTime.required = custom;
  classForm.endTime.required = custom;
}

classForm.timeMode.addEventListener('change', updateCustomTime);
for (const input of [classForm.startTime, classForm.endTime]) {
  input.addEventListener('input', () => classForm.endTime.setCustomValidity(''));
}

// 保存する時間。時限どおりなら空にして、あとで時限の時間を変えても追従させる
function selectedTime() {
  const mode = classForm.timeMode.value;
  if (mode === 'period') return { start: '', end: '' };
  if (mode === 'custom') return { start: classForm.startTime.value, end: classForm.endTime.value };
  return { ...timeChoices[mode] };
}

// 保存は submit の時点で行う（close イベントは遅れて届くことがあり、
// その間に別の授業を開くと returnValue がリセットされて保存漏れになるため）
classForm.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  // 終了が開始より前なら保存させない
  if (classForm.timeMode.value === 'custom' && classForm.startTime.value >= classForm.endTime.value) {
    e.preventDefault();
    switchTab('info');
    classForm.endTime.setCustomValidity('終了時刻は開始時刻より後にしてください');
    classForm.endTime.reportValidity();
    return;
  }
  term().classes[editingKey] = {
    ...draft,
    ...selectedTime(),
    name: classForm.courseName.value.trim(),
    teacher: classForm.teacher.value.trim(),
    room: classForm.room.value.trim(),
    zoomUrl: classForm.zoomUrl.value.trim(),
    utolUrl: classForm.utolUrl.value.trim(),
    campus: classForm.campus.value,
    color: classForm.color.value,
    memo: classForm.memo.value,
  };
  save();
  render();
});

$('#deleteClassBtn').addEventListener('click', () => {
  if (!confirm('この授業を削除しますか？（課題・出欠の記録も消えます）')) return;
  delete term().classes[editingKey];
  save();
  classDialog.close();
  render();
});

// --- 課題タブ ---

function renderDraftTasks() {
  const list = $('#taskList');
  list.innerHTML = '';
  const tasks = [...draft.assignments].sort(compareTasks);
  if (!tasks.length) list.appendChild(el('li', 'empty', '課題はありません'));
  for (const a of tasks) {
    list.appendChild(taskItem(a, null, () => renderDraftTasks(), () => {
      draft.assignments = draft.assignments.filter((x) => x !== a);
      renderDraftTasks();
    }));
  }
  const pending = draft.assignments.filter((a) => !a.done).length;
  $('#taskTabCount').textContent = pending || '';
}

// 課題1件分の行。onChange は完了切り替え後、onDelete は削除ボタン押下時に呼ぶ
function taskItem(a, subText, onChange, onDelete) {
  const li = el('li', a.done ? 'done' : '');
  const check = el('input');
  check.type = 'checkbox';
  check.checked = a.done;
  check.addEventListener('change', () => {
    a.done = check.checked;
    onChange();
  });
  li.appendChild(check);

  const body = el('div', 'task-body');
  body.appendChild(el('div', 'task-title', a.title));
  const due = dueInfo(a);
  body.appendChild(el('div', `task-due ${due.level}`, subText ? `${subText}　${due.label}` : due.label));
  li.appendChild(body);

  if (onDelete) {
    const del = el('button', 'icon', '×');
    del.type = 'button';
    del.title = '削除';
    del.addEventListener('click', () => {
      if (confirm(`「${a.title}」を削除しますか？`)) onDelete();
    });
    li.appendChild(del);
  }
  return li;
}

function addTask() {
  const title = $('#taskTitle').value.trim();
  if (!title) {
    $('#taskTitle').focus();
    return;
  }
  draft.assignments.push({ id: crypto.randomUUID(), title, due: $('#taskDue').value, done: false });
  $('#taskTitle').value = '';
  $('#taskDue').value = '';
  renderDraftTasks();
}

$('#addTaskBtn').addEventListener('click', addTask);
$('#taskTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault(); // フォーム送信（保存して閉じる）を防ぐ
    addTask();
  }
});

// --- 出欠タブ ---

for (const [status, label] of Object.entries(STATUS)) {
  const b = el('button', `status-${status}`, label);
  b.type = 'button';
  b.dataset.status = status;
  b.addEventListener('click', () => {
    setAttendance(draft, $('#attendDate').value, status);
    renderDraftAttendance();
  });
  $('#attendButtons').appendChild(b);
}
$('#attendDate').addEventListener('change', () => renderDraftAttendance());

function renderDraftAttendance() {
  const counts = attendanceCounts(draft);
  const summary = $('#attendSummary');
  summary.innerHTML = '';
  for (const [status, label] of Object.entries(STATUS)) {
    const warn = status === 'absent' && counts.absent >= ABSENCE_WARN;
    const chip = el('div', `chip status-${status}${warn ? ' warn' : ''}`);
    chip.appendChild(el('span', '', label));
    chip.appendChild(el('strong', '', counts[status]));
    summary.appendChild(chip);
  }

  const date = $('#attendDate').value;
  const rec = date && draft.attendance.find((r) => r.date === date);
  $('#attendButtons').querySelectorAll('button').forEach((b) => {
    b.classList.toggle('selected', rec?.status === b.dataset.status);
  });

  const list = $('#attendList');
  list.innerHTML = '';
  // 新しい日付が上、日付不明は一番下
  const records = [...draft.attendance].sort((a, b) => (b.date || '0').localeCompare(a.date || '0'));
  if (!records.length) list.appendChild(el('li', 'empty', 'まだ記録がありません'));
  for (const r of records) {
    const li = el('li');
    li.appendChild(el('span', 'date', formatDate(r.date)));
    li.appendChild(el('span', `status status-${r.status}`, STATUS[r.status]));
    const del = el('button', 'icon', '×');
    del.type = 'button';
    del.title = '削除';
    del.addEventListener('click', () => {
      draft.attendance = draft.attendance.filter((x) => x !== r);
      renderDraftAttendance();
    });
    li.appendChild(del);
    list.appendChild(li);
  }
}

// ---------- 課題一覧 ----------

const tasksDialog = $('#tasksDialog');

function openTasksDialog() {
  renderAllTasks();
  tasksDialog.showModal();
}

function renderAllTasks() {
  const showDone = $('#showDoneTasks').checked;
  const items = Object.entries(term().classes)
    .flatMap(([key, c]) => c.assignments.map((a) => ({ a, c, key })))
    .filter(({ a }) => showDone || !a.done)
    .sort((x, y) => compareTasks(x.a, y.a));

  const list = $('#allTaskList');
  list.innerHTML = '';
  if (!items.length) list.appendChild(el('li', 'empty', showDone ? '課題はありません' : '未完了の課題はありません'));
  for (const { a, c, key } of items) {
    list.appendChild(taskItem(a, `${c.name}（${slotLabel(key)}）`, () => {
      save();
      render();
      renderAllTasks();
    }));
  }
}

$('#tasksBtn').addEventListener('click', openTasksDialog);
$('#showDoneTasks').addEventListener('change', renderAllTasks);

// ---------- 設定 ----------

const settingsDialog = $('#settingsDialog');
const settingsForm = $('#settingsForm');

function periodRow(p) {
  const row = el('div', 'period-row');
  row.innerHTML = `<span></span>
    <input type="time" class="start" required value="${p.start}"> 〜
    <input type="time" class="end" required value="${p.end}">
    <button type="button" title="削除">×</button>`;
  row.querySelector('button').addEventListener('click', () => {
    row.remove();
    numberPeriodRows();
  });
  return row;
}

function numberPeriodRows() {
  document.querySelectorAll('#periodRows .period-row span').forEach((s, i) => {
    s.textContent = `${i + 1}限`;
  });
}

function openSettings() {
  const t = term();
  settingsForm.termName.value = t.name;

  const checks = $('#dayChecks');
  checks.innerHTML = '';
  // 月〜日の順で並べる
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    const label = el('label');
    label.innerHTML = `<input type="checkbox" value="${day}" ${t.days.includes(day) ? 'checked' : ''}>${DAY_NAMES[day]}`;
    checks.appendChild(label);
  }

  const rows = $('#periodRows');
  rows.innerHTML = '';
  t.periods.forEach((p) => rows.appendChild(periodRow(p)));
  numberPeriodRows();

  $('#deleteTermBtn').hidden = state.terms.length <= 1;
  settingsDialog.returnValue = '';
  settingsDialog.showModal();
}

$('#addPeriodBtn').addEventListener('click', () => {
  const rows = document.querySelectorAll('#periodRows .period-row');
  const last = rows[rows.length - 1];
  let start = DEFAULT_PERIODS[0].start;
  let end = DEFAULT_PERIODS[0].end;
  if (last && last.querySelector('.start').value && last.querySelector('.end').value) {
    // 直前の時限と同じ長さで、10分休みを空けて追加
    const prevStart = toMinutes(last.querySelector('.start').value);
    const prevEnd = toMinutes(last.querySelector('.end').value);
    start = fromMinutes(prevEnd + 10);
    end = fromMinutes(prevEnd + 10 + (prevEnd - prevStart));
  }
  $('#periodRows').appendChild(periodRow({ start, end }));
  numberPeriodRows();
});

for (const [key, preset] of Object.entries(PERIOD_PRESETS)) {
  $('#presetSelect').add(new Option(preset.label, key));
}
$('#presetSelect').addEventListener('change', (e) => {
  const preset = PERIOD_PRESETS[e.target.value];
  e.target.value = '';
  if (!preset) return;
  const rows = $('#periodRows');
  rows.innerHTML = '';
  preset.periods.forEach((p) => rows.appendChild(periodRow(p)));
  numberPeriodRows();
});

settingsForm.addEventListener('submit', (e) => {
  if (e.submitter?.value !== 'save') return;
  const t = term();
  t.name = settingsForm.termName.value.trim() || t.name;
  const order = [1, 2, 3, 4, 5, 6, 0];
  t.days = [...document.querySelectorAll('#dayChecks input:checked')]
    .map((i) => Number(i.value))
    .sort((a, b) => order.indexOf(a) - order.indexOf(b));
  t.periods = [...document.querySelectorAll('#periodRows .period-row')].map((row) => ({
    start: row.querySelector('.start').value,
    end: row.querySelector('.end').value,
  }));
  save();
  render();
});

$('#deleteTermBtn').addEventListener('click', () => {
  if (!confirm(`「${term().name}」を削除しますか？（元に戻せません）`)) return;
  state.terms = state.terms.filter((t) => t.id !== state.currentTermId);
  state.currentTermId = state.terms[0].id;
  save();
  settingsDialog.close();
  render();
});

// キャンセルボタン（Enterキーで誤って押されないよう submit にしていない）
document.querySelectorAll('[data-close]').forEach((b) => {
  b.addEventListener('click', () => b.closest('dialog').close());
});

// ---------- 学期 ----------

$('#termSelect').addEventListener('change', (e) => {
  state.currentTermId = e.target.value;
  save();
  render();
});

$('#addTermBtn').addEventListener('click', () => {
  const name = prompt('新しい学期の名前', defaultTermName());
  if (!name) return;
  const t = newTerm(name.trim(), term()); // 曜日・時限設定は現在の学期を引き継ぐ
  state.terms.push(t);
  state.currentTermId = t.id;
  save();
  render();
});

$('#settingsBtn').addEventListener('click', openSettings);

// ---------- 書き出し / 読み込み ----------

$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `timetable-${localDate()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('#importInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!Array.isArray(data.terms) || !data.terms.length) throw new Error('形式が不正です');
    if (!confirm('現在のデータを読み込んだデータで置き換えますか？')) return;
    state = normalize(data);
    save();
    render();
  } catch (err) {
    alert(`読み込みに失敗しました：${err.message}`);
  }
});

// ---------- 起動 ----------

function refreshClock() {
  renderTable();
  renderNow();
  renderTaskCount();
}

render();
setInterval(refreshClock, 60 * 1000);

// スマホでアプリから戻ったときにすぐ現在時刻に合わせる
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshClock();
});

// オフライン対応（file:// で開いたときは使えないので無視）
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
