// =====================================================================
//  YouTube発見ページ 裏側（Cloudflare Worker）
// =====================================================================

// ---------------------------------------------------------------------
//  ★ジャンルの検索語はここで直せます★
//   ja = 「日本のみ」のときの検索語 / en = 「海外も含む」のときの検索語
//   ボタンの表示名は docs/app.js の先頭にあります（キー名は同じにしてください）
// ---------------------------------------------------------------------
const GENRES = {
  economy:  { ja: "経済ニュース",       en: "economy news" },
  industry: { ja: "産業ニュース",       en: "industry news" },
  tech:     { ja: "テクノロジーニュース", en: "technology news" },
  general:  { ja: "総合ニュース",       en: "world news" },
  travel:   { ja: "旅行",               en: "travel vlog" },
  pet:      { ja: "ペット",             en: "cute pets" },
};

// ---------------------------------------------------------------------
//  設定値
// ---------------------------------------------------------------------
const MAX_QUERY_LEN = 50;          // フリーワードの最大文字数
const RESULT_COUNT = 20;           // 画面へ返す件数
const MIN_SECONDS = 181;           // 3分以下（ショート動画など）は除外
const CACHE_HOURS = { day: 1, week: 3, month: 6 }; // 結果の保存時間
const PERIOD_MS = { day: 864e5, week: 7 * 864e5, month: 30 * 864e5 };
const DAILY_SEARCH_LIMIT = 95;     // 1日の検索回数の自主上限（YouTube側は100回）
const RATE_LIMIT_PER_MIN = 20;     // 同じ相手からの1分あたりの呼び出し上限
const TRANSLATE_MODEL = "@cf/meta/m2m100-1.2b";

// ---------------------------------------------------------------------
//  入口
// ---------------------------------------------------------------------
export default {
  async fetch(req, env) {
    const origin = req.headers.get("Origin");
    const allowed = env.ALLOWED_ORIGIN;

    // このページのURL以外からの呼び出しは受け付けない
    if (!origin || origin !== allowed) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    const cors = {
      "Access-Control-Allow-Origin": allowed,
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    if (req.method !== "GET" || url.pathname !== "/api/videos") {
      return reply({ error: "notfound" }, 404, cors);
    }

    try {
      if (!(await rateOk(env, req))) return reply({ error: "rate" }, 429, cors);
      return await handleVideos(url, env, cors);
    } catch (e) {
      // 中身（キー等）が出ないよう、エラーの種類だけ返す
      return reply({ error: "server" }, 500, cors);
    }
  },
};

function reply(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...cors },
  });
}

// ---------------------------------------------------------------------
//  動画一覧
// ---------------------------------------------------------------------
async function handleVideos(url, env, cors) {
  const sp = url.searchParams;
  const period = ["day", "week", "month"].includes(sp.get("period")) ? sp.get("period") : "day";
  const order = sp.get("order") === "random" ? "random" : "popular";
  const scope = sp.get("scope") === "world" ? "world" : "jp";
  const freeword = (sp.get("q") || "").trim();
  const genreKey = sp.get("genre") || "";

  if ([...freeword].length > MAX_QUERY_LEN) return reply({ error: "toolong" }, 400, cors);

  let q;
  if (freeword) {
    q = freeword;
  } else if (GENRES[genreKey]) {
    q = GENRES[genreKey][scope === "world" ? "en" : "ja"];
  } else {
    return reply({ error: "bad" }, 400, cors);
  }

  const cacheKey = [q, period, order, scope].join("|");
  const now = Date.now();
  const cached = await env.DB.prepare("SELECT body, expires FROM cache WHERE k = ?").bind(cacheKey).first();

  let list = null;
  let stale = false;

  if (cached && cached.expires > now) {
    list = JSON.parse(cached.body);
  } else {
    const ok = await searchAllowed(env);
    if (ok) {
      const res = await fetchFromYouTube(env, { q, period, order, scope });
      if (res.ok) {
        list = res.list;
        await env.DB.prepare("INSERT OR REPLACE INTO cache (k, body, expires) VALUES (?, ?, ?)")
          .bind(cacheKey, JSON.stringify(list), now + CACHE_HOURS[period] * 36e5).run();
      } else if (res.quota) {
        await markQuotaUsed(env);
      }
    }
    if (!list && cached) { list = JSON.parse(cached.body); stale = true; }
    if (!list) {
      return reply({ error: ok ? "upstream" : "quota" }, ok ? 502 : 429, cors);
    }
  }

  // 並び：人気順は再生回数の多い順、ランダムは毎回シャッフル（YouTubeへは問い合わせない）
  let items = list.slice();
  if (order === "popular") items.sort((a, b) => b.views - a.views);
  else shuffle(items);
  items = items.slice(0, RESULT_COUNT).map((v) => ({ ...v }));

  // 「海外も含む」のとき、日本語でないタイトルを和訳
  if (scope === "world") await addTranslations(env, items);

  return reply({ items, stale }, 200, cors);
}

// ---------------------------------------------------------------------
//  YouTube Data API
// ---------------------------------------------------------------------
async function fetchFromYouTube(env, { q, period, order, scope }) {
  const sp = new URLSearchParams({
    part: "snippet",
    type: "video",
    maxResults: "50",
    q,
    publishedAfter: new Date(Date.now() - PERIOD_MS[period]).toISOString(),
    order: order === "popular" ? "viewCount" : "relevance",
    key: env.YOUTUBE_API_KEY,
  });
  if (scope === "jp") {
    sp.set("regionCode", "JP");
    sp.set("relevanceLanguage", "ja");
  }

  const s = await ytGet("https://www.googleapis.com/youtube/v3/search?" + sp);
  if (!s.ok) return s;
  const ids = (s.data.items || []).map((i) => i.id && i.id.videoId).filter(Boolean);
  if (!ids.length) return { ok: true, list: [] };

  const vp = new URLSearchParams({
    part: "snippet,contentDetails,statistics",
    id: ids.join(","),
    maxResults: "50",
    key: env.YOUTUBE_API_KEY,
  });
  const v = await ytGet("https://www.googleapis.com/youtube/v3/videos?" + vp);
  if (!v.ok) return v;

  const list = [];
  for (const it of v.data.items || []) {
    const sec = isoToSeconds(it.contentDetails && it.contentDetails.duration);
    if (sec < MIN_SECONDS) continue;                                  // 3分以下を除外
    if (it.snippet.liveBroadcastContent !== "none") continue;         // ライブ・配信予定を除外
    list.push({
      id: it.id,
      title: decodeEntities(it.snippet.title),
      channel: decodeEntities(it.snippet.channelTitle),
      views: Number((it.statistics && it.statistics.viewCount) || 0),
      seconds: sec,
      publishedAt: it.snippet.publishedAt,
      thumb: `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg`,
    });
  }
  return { ok: true, list };
}

async function ytGet(u) {
  try {
    const r = await fetch(u);
    if (r.ok) return { ok: true, data: await r.json() };
    let quota = false;
    if (r.status === 403) {
      try {
        const j = await r.json();
        quota = !!(j.error && j.error.errors && j.error.errors.some((e) => e.reason === "quotaExceeded"));
      } catch (_) {}
    }
    return { ok: false, quota };
  } catch (_) {
    return { ok: false, quota: false };
  }
}

// ---------------------------------------------------------------------
//  1日の検索回数の管理（太平洋時間の日付ごと。YouTube側のリセットと合わせる）
// ---------------------------------------------------------------------
function pacificDay() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}
async function searchAllowed(env) {
  const day = pacificDay();
  const row = await env.DB.prepare("SELECT n FROM quota WHERE day = ?").bind(day).first();
  if (row && row.n >= DAILY_SEARCH_LIMIT) return false;
  await env.DB.prepare(
    "INSERT INTO quota (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1"
  ).bind(day).run();
  return true;
}
async function markQuotaUsed(env) {
  await env.DB.prepare(
    "INSERT INTO quota (day, n) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET n = ?"
  ).bind(pacificDay(), DAILY_SEARCH_LIMIT, DAILY_SEARCH_LIMIT).run();
}

// ---------------------------------------------------------------------
//  連続呼び出しの制限（相手のIPは暗号化した値だけ保存）
// ---------------------------------------------------------------------
async function rateOk(env, req) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown";
  const minute = Math.floor(Date.now() / 6e4);
  const k = (await sha256(ip)).slice(0, 16) + ":" + minute;
  const row = await env.DB.prepare(
    "INSERT INTO rl (k, n, exp) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1 RETURNING n"
  ).bind(k, Date.now() + 12e4).first();
  if (Math.random() < 0.02) {
    await env.DB.prepare("DELETE FROM rl WHERE exp < ?").bind(Date.now()).run();
  }
  return row.n <= RATE_LIMIT_PER_MIN;
}
async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------
//  タイトルの和訳（Workers AI）。失敗しても原題だけ返して止めない
// ---------------------------------------------------------------------
const HAS_JA = /[぀-ヿ㐀-鿿]/;

async function addTranslations(env, items) {
  const need = items.filter((i) => !HAS_JA.test(i.title));
  if (!need.length) return;
  try {
    const ids = need.map((i) => i.id);
    const rows = await env.DB.prepare(
      `SELECT vid, ja FROM trans WHERE vid IN (${ids.map(() => "?").join(",")})`
    ).bind(...ids).all();
    const done = new Map((rows.results || []).map((r) => [r.vid, r.ja]));

    const todo = [];
    for (const it of need) {
      if (done.has(it.id)) it.titleJa = done.get(it.id);
      else todo.push(it);
    }

    let stop = false;
    for (let i = 0; i < todo.length && !stop; i += 5) {
      await Promise.all(
        todo.slice(i, i + 5).map(async (it) => {
          try {
            const r = await env.AI.run(TRANSLATE_MODEL, {
              text: it.title.slice(0, 200),
              source_lang: "english",
              target_lang: "japanese",
            });
            const ja = r && r.translated_text;
            if (ja) {
              it.titleJa = ja;
              await env.DB.prepare("INSERT OR REPLACE INTO trans (vid, ja) VALUES (?, ?)").bind(it.id, ja).run();
            }
          } catch (_) {
            stop = true; // 無料枠切れなど。以降は訳さず原題のみ
          }
        })
      );
    }
  } catch (_) {
    /* 和訳なしで続行 */
  }
}

// ---------------------------------------------------------------------
//  小さな道具
// ---------------------------------------------------------------------
function isoToSeconds(d) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || "");
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}
function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
