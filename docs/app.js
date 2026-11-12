// ===================================================================
//  設定（ここだけ直せば動きます）
// ===================================================================
// 裏側(Worker)のアドレス。公開後に実際のアドレスへ書き換える
const API_BASE = "https://youtube-discover-api.pescados.workers.dev";

// ジャンルボタンの表示名。key は worker/src/index.js の GENRES と同じにする
// （"mix" は「おまかせ」＝全ジャンルを混ぜて表示する特別なボタン）
const GENRES = [
  { key: "mix",      label: "おまかせ" },
  { key: "economy",  label: "経済ニュース" },
  { key: "industry", label: "産業ニュース" },
  { key: "tech",     label: "テクノロジーニュース" },
  { key: "general",  label: "総合ニュース" },
  { key: "travel",   label: "旅行" },
  { key: "pet",      label: "ペット" },
];

// ===================================================================
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} },
};

const state = Object.assign(
  { genre: "mix", q: "", period: "day", order: "popular", scope: "jp" },
  store.get("yd_state", {})
);
let recent = store.get("yd_recent", []);
let seq = 0; // 古い応答で画面が上書きされないための番号

function save() { store.set("yd_state", state); }

// ---------- 画面の組み立て ----------
function renderGenres() {
  const box = $("genres");
  box.innerHTML = "";
  for (const g of GENRES) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = g.label;
    if (!state.q && state.genre === g.key) b.className = "on";
    b.onclick = () => { state.genre = g.key; state.q = ""; $("q").value = ""; save(); refresh(); };
    box.appendChild(b);
  }
}

function renderRecent() {
  const box = $("recent");
  box.innerHTML = "";
  for (const w of recent) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = w;
    b.onclick = () => runSearch(w);
    box.appendChild(b);
  }
}

function renderSwitches() {
  document.querySelectorAll(".sw").forEach((sw) => {
    const key = sw.dataset.key;
    sw.querySelectorAll("button").forEach((b) => {
      b.className = b.dataset.val === state[key] ? "on" : "";
      b.onclick = () => { state[key] = b.dataset.val; save(); refresh(); };
    });
  });
}

function refresh() {
  renderGenres();
  renderSwitches();
  $("again").hidden = true;
  load();
}

// ---------- 検索 ----------
function runSearch(word) {
  word = (word || "").trim();
  if (!word) return;
  if ([...word].length > 50) { setStatus("ことばは50文字までです。", true); return; }
  state.q = word;
  $("q").value = word;
  recent = [word, ...recent.filter((w) => w !== word)].slice(0, 5);
  store.set("yd_recent", recent);
  save();
  renderRecent();
  refresh();
}

// ---------- 取得と表示 ----------
function setStatus(text, isErr) {
  const s = $("status");
  s.textContent = text || "";
  s.className = "status" + (isErr ? " err" : "");
}

async function load() {
  const my = ++seq;
  $("list").innerHTML = "";
  setStatus("読み込み中…");

  const p = new URLSearchParams({ period: state.period, order: state.order, scope: state.scope });
  if (state.q) p.set("q", state.q); else p.set("genre", state.genre);

  let res, data;
  try {
    res = await fetch(API_BASE + "/api/videos?" + p);
    data = await res.json();
  } catch (_) {
    if (my === seq) setStatus("通信できませんでした。電波の良いところで、もう一度お試しください。", true);
    return;
  }
  if (my !== seq) return;

  if (!res.ok) {
    const msg = {
      quota: "本日の検索の上限に達しました。明日またお試しください。",
      rate: "短い間に押しすぎました。少し待ってからお試しください。",
      toolong: "ことばは50文字までです。",
    }[data.error] || "うまく取得できませんでした。しばらくしてからお試しください。";
    setStatus(msg, true);
    return;
  }

  const items = data.items || [];
  if (!items.length) {
    setStatus("この条件の動画は見つかりませんでした。期間を「今週」「今月」に広げてみてください。");
    return;
  }
  setStatus(data.stale ? "（上限のため、少し前の結果を表示しています）" : "");
  renderList(items);
  $("again").hidden = state.order !== "random";
}

function renderList(items) {
  const ul = $("list");
  for (const v of items) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.className = "card";
    a.href = "https://www.youtube.com/watch?v=" + encodeURIComponent(v.id);
    a.target = "_blank";
    a.rel = "noopener";

    const th = document.createElement("div");
    th.className = "thumb";
    const img = document.createElement("img");
    img.src = v.thumb; img.alt = ""; img.loading = "lazy";
    const dur = document.createElement("span");
    dur.className = "dur"; dur.textContent = fmtDur(v.seconds);
    th.append(img, dur);

    const info = document.createElement("div");
    info.className = "info";
    const t = document.createElement("p");
    t.className = "title";
    t.textContent = v.titleJa || v.title;
    info.appendChild(t);
    if (v.titleJa) {
      const o = document.createElement("p");
      o.className = "orig"; o.textContent = v.title;
      info.appendChild(o);
    }
    const m = document.createElement("p");
    m.className = "meta";
    m.textContent = `${v.channel} ・ ${fmtViews(v.views)} ・ ${fmtAgo(v.publishedAt)}`;
    if (v.genre) {
      const g = GENRES.find((x) => x.key === v.genre);
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = g ? g.label : v.genre;
      info.prepend(tag);
    }
    info.appendChild(m);

    a.append(th, info);
    li.appendChild(a);
    ul.appendChild(li);
  }
}

// ---------- 表示の整形 ----------
function fmtDur(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`;
}
function fmtViews(n) {
  if (n >= 1e8) return (n / 1e8).toFixed(1).replace(/\.0$/, "") + "億回視聴";
  if (n >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, "") + "万回視聴";
  return n.toLocaleString() + "回視聴";
}
function fmtAgo(iso) {
  const min = Math.max(0, (Date.now() - new Date(iso).getTime()) / 6e4);
  if (min < 60) return Math.max(1, Math.floor(min)) + "分前";
  if (min < 1440) return Math.floor(min / 60) + "時間前";
  return Math.floor(min / 1440) + "日前";
}

// ---------- 起動 ----------
$("searchForm").addEventListener("submit", (e) => { e.preventDefault(); runSearch($("q").value); });
$("again").onclick = () => { load(); window.scrollTo({ top: 0, behavior: "smooth" }); };
$("q").value = state.q;
renderRecent();
refresh();
