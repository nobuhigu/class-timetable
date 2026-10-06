'use strict';

const STORAGE_KEY = 'class-timetable-v1';
const DAY_NAMES = ['日', '月', '火', '水', '木', '金', '土'];
const ABSENCE_WARN = 3; // この回数以上の欠席で警告表示

const DEFAULT_PERIODS = [
  { start: '09:00', end: '10:30' },
  { start: '10:40', end: '12:10' },
  { start: '13:00', end: '14:30' },
  { start: '14:40', end: '16:10' },
  { start: '16:20', end: '17:50' },
  { start: '18:00', end: '19:30' },
];

const $ = (sel) => document.querySelector(sel);

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

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (data && Array.isArray(data.terms) && data.terms.length) return data;
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

// ---------- 時間ユーティリティ ----------

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function nowInfo() {
  const d = new Date();
  return { day: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() };
}

// ---------- 描画 ----------

function render() {
  renderTermSelect();
  renderTable();
  renderNow();
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
  head.appendChild(document.createElement('th'));
  for (const day of t.days) {
    const th = document.createElement('th');
    th.textContent = DAY_NAMES[day];
    if (day === today) th.classList.add('today');
    head.appendChild(th);
  }

  const body = table.createTBody();
  t.periods.forEach((p, i) => {
    const row = body.insertRow();
    const th = document.createElement('th');
    th.className = 'period';
    th.innerHTML = `<span class="num">${i + 1}</span><span class="time">${p.start}<br>〜${p.end}</span>`;
    row.appendChild(th);

    const isNow = minutes >= toMinutes(p.start) && minutes < toMinutes(p.end);
    for (const day of t.days) {
      const td = row.insertCell();
      const key = `${day}-${i}`;
      if (day === today) td.classList.add('today');
      if (day === today && isNow) td.classList.add('current');
      td.addEventListener('click', () => openClassDialog(day, i));

      const c = t.classes[key];
      if (c) td.appendChild(classCell(c));
    }
  });
}

function classCell(c) {
  const div = document.createElement('div');
  div.className = 'cls';
  div.style.setProperty('--c', c.color);

  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = c.name;
  div.appendChild(name);

  const sub = [c.room, c.teacher].filter(Boolean).join(' / ');
  if (sub) {
    const el = document.createElement('div');
    el.className = 'sub';
    el.textContent = sub;
    div.appendChild(el);
  }

  const badges = document.createElement('div');
  badges.className = 'badges';
  if (c.memo) badges.appendChild(badge('メモ'));
  if (c.absences > 0) badges.appendChild(badge(`欠${c.absences}`, c.absences >= ABSENCE_WARN));
  div.appendChild(badges);
  return div;
}

function badge(text, warn = false) {
  const el = document.createElement('span');
  el.className = 'badge' + (warn ? ' warn' : '');
  el.textContent = text;
  return el;
}

// 「今の授業」「次の授業」を表示
function renderNow() {
  const t = term();
  const { day, minutes } = nowInfo();
  const el = $('#now');
  el.textContent = '';
  if (!t.days.includes(day)) return;

  const todays = t.periods
    .map((p, i) => ({ p, i, c: t.classes[`${day}-${i}`] }))
    .filter((x) => x.c);
  if (!todays.length) {
    el.textContent = '今日は授業がありません';
    return;
  }

  const current = todays.find(({ p }) => minutes >= toMinutes(p.start) && minutes < toMinutes(p.end));
  const next = todays.find(({ p }) => toMinutes(p.start) > minutes);
  const fmt = ({ p, i, c }) => `${i + 1}限 ${c.name}${c.room ? `（${c.room}）` : ''} ${p.start}〜${p.end}`;

  const parts = [];
  if (current) parts.push(`授業中：${fmt(current)}`);
  if (next) parts.push(`次：${fmt(next)}（あと${toMinutes(next.p.start) - minutes}分）`);
  el.textContent = parts.length ? parts.join('　｜　') : '今日の授業は終わりました';
}

// ---------- 授業編集 ----------

const classDialog = $('#classDialog');
const classForm = $('#classForm');
let editingKey = null;

function openClassDialog(day, periodIndex) {
  editingKey = `${day}-${periodIndex}`;
  const c = term().classes[editingKey];
  $('#classDialogTitle').textContent = `${DAY_NAMES[day]}曜 ${periodIndex + 1}限`;
  classForm.courseName.value = c?.name ?? '';
  classForm.room.value = c?.room ?? '';
  classForm.teacher.value = c?.teacher ?? '';
  classForm.color.value = c?.color ?? '#4f8cff';
  classForm.absences.value = c?.absences ?? 0;
  classForm.memo.value = c?.memo ?? '';
  $('#deleteClassBtn').hidden = !c;
  classDialog.returnValue = '';
  classDialog.showModal();
}

classForm.querySelectorAll('.counter button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = classForm.absences;
    input.value = Math.max(0, Number(input.value) + Number(btn.dataset.step));
  });
});

classDialog.addEventListener('close', () => {
  if (classDialog.returnValue !== 'save') return;
  term().classes[editingKey] = {
    name: classForm.courseName.value.trim(),
    room: classForm.room.value.trim(),
    teacher: classForm.teacher.value.trim(),
    color: classForm.color.value,
    absences: Math.max(0, Number(classForm.absences.value) || 0),
    memo: classForm.memo.value,
  };
  save();
  render();
});

$('#deleteClassBtn').addEventListener('click', () => {
  if (!confirm('この授業を削除しますか？')) return;
  delete term().classes[editingKey];
  save();
  classDialog.close();
  render();
});

// ---------- 設定 ----------

const settingsDialog = $('#settingsDialog');
const settingsForm = $('#settingsForm');

function periodRow(p) {
  const row = document.createElement('div');
  row.className = 'period-row';
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
    const label = document.createElement('label');
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
  let start = '09:00';
  let end = '10:30';
  if (last) {
    const s = toMinutes(last.querySelector('.end').value || '09:00') + 10;
    const fmt = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    start = fmt(s);
    end = fmt(s + 90);
  }
  $('#periodRows').appendChild(periodRow({ start, end }));
  numberPeriodRows();
});

settingsDialog.addEventListener('close', () => {
  if (settingsDialog.returnValue !== 'save') return;
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
  a.download = `timetable-${new Date().toISOString().slice(0, 10)}.json`;
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
    state = data;
    if (!state.terms.some((t) => t.id === state.currentTermId)) state.currentTermId = state.terms[0].id;
    save();
    render();
  } catch (err) {
    alert(`読み込みに失敗しました：${err.message}`);
  }
});

// ---------- 起動 ----------

render();
setInterval(() => {
  renderTable();
  renderNow();
}, 60 * 1000);

// スマホでアプリから戻ったときにすぐ現在時刻に合わせる
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    renderTable();
    renderNow();
  }
});

// オフライン対応（file:// で開いたときは使えないので無視）
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
