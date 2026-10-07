/* 开桌 · 公共模块：数据同步、服务器唤醒提示、本机报名凭证、弹窗与通用渲染 */
(function () {
  "use strict";

  const STATE_CACHE = "bgc.state.v4";
  const MINE_KEY = "bgc.mine.v1";
  const NAME_KEY = "bgc.lastName";
  const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const LEVELS = ["没玩过", "玩过几次", "熟练能教"];
  const DIFF = ["", "轻松", "适中", "进阶"];
  const INK = ["#1f6f8b", "#b0247a", "#4d7c0f", "#b45309", "#6d4bd8", "#c62828", "#00796b", "#1565c0"];
  const NEON = ["#22e5ff", "#ff2bd6", "#b6ff3b", "#ffb020", "#a78bff", "#ff5d73", "#2dffb3", "#4da3ff"];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };

  // ---------- 时间 ----------
  let clockOffset = 0; // 服务器时间 - 本机时间，修正手机时间不准
  const now = () => Date.now() + clockOffset;
  const pad = n => String(n).padStart(2, "0");
  function fmtDate(key, withWeekday = true) {
    const [y, m, d] = key.split("-").map(Number);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return `${m}月${d}日${withWeekday ? ` ${WEEKDAYS[wd]}` : ""}`;
  }
  function relDay(key, tzMin = 480) {
    const today = new Date(now() + tzMin * 60000).toISOString().slice(0, 10);
    const diff = Math.round((Date.parse(`${key}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
    if (diff === 0) return "今天";
    if (diff === 1) return "明天";
    if (diff === 2) return "后天";
    const monday = k => {
      const t = Date.parse(`${k}T00:00:00Z`);
      return t - ((new Date(t).getUTCDay() + 6) % 7) * 86400000;
    };
    const weeks = Math.round((monday(key) - monday(today)) / (7 * 86400000));
    if (weeks <= 0) return "本周";
    if (weeks === 1) return "下周";
    return `${weeks} 周后`;
  }
  function splitDuration(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    return { d: Math.floor(t / 86400), h: Math.floor((t % 86400) / 3600), m: Math.floor((t % 3600) / 60), s: t % 60 };
  }
  // 服务器不可达且没有缓存时，本地推算下一个周五 18:30（UTC+8）
  function fallbackSession() {
    const tz = 480;
    const local = new Date(Date.now() + tz * 60000);
    let delta = (5 - local.getUTCDay() + 7) % 7;
    const key = d => new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + d)).toISOString().slice(0, 10);
    const startOf = k => Date.parse(`${k}T18:30:00Z`) - tz * 60000;
    if (Date.now() > startOf(key(delta)) + 3.5 * 3600000) delta += 7;
    const k = key(delta);
    return { id: k, date: k, time: "18:30", endTime: "22:00", startAt: startOf(k), endAt: startOf(k) + 3.5 * 3600000, location: "R312", status: Date.now() >= startOf(k) ? "live" : "open", gameIds: [], alloc: { games: {}, totals: { signups: 0, seated: 0, tablesReady: 0, waitlist: 0 } }, fallback: true };
  }

  // ---------- 唤醒提示 ----------
  let wakeTimer = null;
  let wakeStarted = 0;
  let pending = 0;
  function wakeBanner(show) {
    let el = $("#wakeBanner");
    if (show && !el) {
      el = document.createElement("div");
      el.id = "wakeBanner";
      el.className = "wake-banner";
      el.setAttribute("role", "status");
      el.innerHTML = `<span class="wake-dot"></span><span><strong>服务器正在唤醒</strong><small>免费服务器闲置后会休眠，首次访问约需 30–60 秒，请稍候 <b id="wakeSecs" aria-hidden="true">0</b><span aria-hidden="true">s</span></small></span>`;
      document.body.appendChild(el);
    }
    if (!el) return;
    if (show) {
      wakeStarted = Date.now();
      el.classList.add("show");
      clearInterval(el._t);
      el._t = setInterval(() => {
        const s = $("#wakeSecs");
        if (s) s.textContent = Math.round((Date.now() - wakeStarted) / 1000);
      }, 1000);
    } else {
      el.classList.remove("show");
      clearInterval(el._t);
    }
  }

  async function api(path, { method = "GET", body, admin, token, timeout = 95000 } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (admin) headers["X-Admin-Key"] = admin;
    if (token) headers["X-Edit-Token"] = token;
    const ctrl = new AbortController();
    const kill = setTimeout(() => ctrl.abort(), timeout);
    pending++;
    if (!wakeTimer) wakeTimer = setTimeout(() => wakeBanner(true), 2500);
    try {
      const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal, cache: "no-store" });
      const type = res.headers.get("content-type") || "";
      const data = type.includes("json") ? await res.json() : await res.text();
      if (!res.ok) {
        const err = new Error((data && data.error) || `请求失败（${res.status}）`);
        err.status = res.status;
        throw err;
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw Object.assign(new Error("服务器响应超时，请检查网络后重试"), { status: 0 });
      if (error instanceof TypeError) throw Object.assign(new Error("网络连接失败，请检查网络后重试"), { status: 0 });
      throw error;
    } finally {
      clearTimeout(kill);
      pending--;
      if (pending <= 0) {
        pending = 0;
        clearTimeout(wakeTimer);
        wakeTimer = null;
        wakeBanner(false);
      }
    }
  }

  // ---------- 共享状态 ----------
  let snapshot = null;
  const listeners = new Set();
  function liveStatus(s) {
    if (!s || s.status === "cancelled") return s && s.status;
    const t = now();
    if (t >= s.endAt) return "ended";
    if (t >= s.startAt) return "live";
    return "open";
  }
  // 返回 true 表示有场次状态变了
  function refreshStatuses(snap) {
    let changed = false;
    for (const s of snap.sessions) {
      const st = liveStatus(s);
      if (st && st !== s.status) {
        s.status = st;
        changed = true;
      }
    }
    const before = snap.sessions.length;
    snap.sessions = snap.sessions.filter(s => s.status !== "ended");
    return changed || snap.sessions.length !== before;
  }
  function emit() {
    listeners.forEach(fn => {
      try {
        fn(snapshot);
      } catch (e) {
        console.error(e);
      }
    });
  }
  function setSnapshot(data, fromCache = false) {
    if (!data || !Array.isArray(data.sessions)) return;
    snapshot = data;
    if (!fromCache) {
      clockOffset = Number(data.serverNow) ? data.serverNow - Date.now() : 0;
      store.set(STATE_CACHE, { ...data, cachedAt: Date.now() });
    }
    snapshot.fromCache = fromCache;
    refreshStatuses(snapshot);
    emit();
  }
  setInterval(() => {
    if (snapshot && refreshStatuses(snapshot)) emit();
  }, 5000);
  function onState(fn) {
    listeners.add(fn);
    if (snapshot) fn(snapshot);
    return () => listeners.delete(fn);
  }
  let refreshing = null;
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = api("/api/state")
      .then(data => {
        setSnapshot(data);
        degraded(false);
        return data;
      })
      .catch(error => {
        if (error.status === 503) degraded(true);
        throw error;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }
  function boot({ poll = 30000 } = {}) {
    const cached = store.get(STATE_CACHE, null);
    if (cached && Array.isArray(cached.sessions)) setSnapshot(cached, true);
    const first = refresh().catch(error => {
      if (!snapshot) toast(error.message, "error");
      throw error;
    });
    if (poll) {
      setInterval(() => {
        if (document.visibilityState === "visible") refresh().catch(() => {});
      }, poll);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refresh().catch(() => {});
      });
    }
    return first;
  }
  const gameById = id => snapshot?.games.find(g => g.id === id);
  let isDegraded = false;
  function degraded(on) {
    isDegraded = on;
    let el = $("#degradedBar");
    if (on && !el) {
      el = document.createElement("div");
      el.id = "degradedBar";
      el.className = "wake-banner show";
      el.setAttribute("role", "status");
      el.innerHTML = `<span class="wake-dot"></span><span><strong>报名数据暂时无法读取</strong><small>页面显示的是上次保存的内容，请稍后刷新；暂时无法提交报名</small></span>`;
      document.body.appendChild(el);
    }
    if (!on && el) el.remove();
  }

  // ---------- 本机报名凭证 ----------
  function getMine() {
    const list = store.get(MINE_KEY, []);
    return Array.isArray(list) ? list.filter(x => x && x.id && x.token) : [];
  }
  function saveMine(entry) {
    const list = getMine().filter(x => x.id !== entry.id);
    list.unshift({ ...entry, savedAt: Date.now() });
    store.set(MINE_KEY, list.slice(0, 30));
  }
  function removeMine(id) {
    store.set(MINE_KEY, getMine().filter(x => x.id !== id));
  }
  function updateMine(id, patch) {
    store.set(MINE_KEY, getMine().map(x => (x.id === id ? { ...x, ...patch } : x)));
  }
  // 在快照里找到某条报名的分桌结果
  function placementOf(session, signupId) {
    if (!session?.alloc) return null;
    for (const [gameId, g] of Object.entries(session.alloc.games)) {
      for (const t of g.tables) {
        const p = t.players.find(x => x.id === signupId);
        if (p) return { kind: "seat", gameId, table: t.no, short: t.short, via: p.via, player: p, game: g };
      }
      const wi = g.waitlist.findIndex(x => x.id === signupId);
      if (wi >= 0) return { kind: "wait", gameId, position: wi + 1, player: g.waitlist[wi], game: g };
    }
    const o = (session.alloc.orphans || []).find(x => x.id === signupId);
    if (o) return { kind: "orphan", player: o };
    return null;
  }
  function placementText(pl) {
    if (!pl) return "未找到（可能已被取消）";
    const name = gameById(pl.gameId)?.name || "";
    if (pl.kind === "wait") return `${name} · 候补第 ${pl.position} 位`;
    if (pl.kind === "orphan") return "所选游戏已下架，请修改报名";
    const via = pl.via === "alt" ? "（第二志愿）" : "";
    return pl.short > 0 ? `${name}${via} · 第 ${pl.table} 桌，还差 ${pl.short} 人成桌` : `${name}${via} · 第 ${pl.table} 桌`;
  }

  // ---------- 状态文字 ----------
  function seatInfo(g, gameAlloc) {
    if (!gameAlloc) return { tone: "idle", text: `${g.min}–${g.max} 人`, short: "" };
    const a = gameAlloc;
    if (a.status === "full") return { tone: "full", text: "满员 · 可排候补", short: "满员·可候补" };
    if (a.status === "empty") return { tone: "idle", text: `等你开桌 · ${a.min} 人成桌`, short: "等你开桌" };
    if (a.status === "forming") return { tone: "forming", text: `已有 ${a.count} 人 · 还差 ${a.need} 人成桌`, short: `差${a.need}人成桌` };
    return { tone: "ok", text: `已成桌 · 余 ${a.seatsLeft} 座`, short: `余${a.seatsLeft}座` };
  }
  function sessionLabel(s) {
    return { open: "报名中", live: "进行中", ended: "已结束", cancelled: "停办" }[s.status] || "";
  }

  // ---------- 图标（每款游戏一个霓虹线条图标） ----------
  const ICONS = {
    house: '<path d="M4 20V10l8-6 8 6v10"/><path d="M9 20v-5h6v5"/><path d="M8 11h.01M16 11h.01"/><path d="M12 2v2"/>',
    gem: '<path d="M6 4h12l3 5-9 11L3 9z"/><path d="M3 9h18M9 4l3 16M15 4l-3 16"/>',
    flag: '<path d="M5 21V4"/><path d="M5 4h12l-2 4 2 4H5"/><circle cx="18" cy="19" r="2"/><path d="M12 19h4"/>',
    shuriken: '<path d="M12 2l2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5z"/><circle cx="12" cy="12" r="2"/>',
    bubble: '<path d="M4 5h16v11H9l-5 4z"/><path d="M10 9.5a2 2 0 1 1 2.5 1.9c-.4.1-.5.4-.5.8v.3M12 14h.01"/>',
    moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/><path d="M15 3l1 2M19 7l2-1"/>',
    shield: '<path d="M12 2l8 3v6c0 5-3.5 9-8 11-4.5-2-8-6-8-11V5z"/><path d="M12 7v9M9 10h6"/>',
    dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2"/><circle cx="15" cy="15" r="1.2"/><circle cx="15" cy="9" r="1.2"/><circle cx="9" cy="15" r="1.2"/>',
    crown: '<path d="M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z"/><path d="M5 19h14"/><circle cx="12" cy="14" r="1.3"/>',
    sub: '<path d="M3 15a4 4 0 0 1 4-4h9a4 4 0 0 1 0 8H7a4 4 0 0 1-4-4z"/><path d="M11 11V6h4"/><circle cx="9" cy="15" r="1"/><circle cx="13" cy="15" r="1"/><path d="M20 15h2"/>',
    mask: '<path d="M3 7c3-1.5 6-1.5 9 0 3-1.5 6-1.5 9 0v4c0 4-3 7-6 7-1.5 0-2.4-1-3-2-.6 1-1.5 2-3 2-3 0-6-3-6-7z"/><path d="M6.5 11h3M14.5 11h3"/>',
    mug: '<path d="M5 8h11v10a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3z"/><path d="M16 10h2a2 2 0 0 1 0 4h-2"/><path d="M8 3.5c0 1 1 1.2 1 2.3M12 3.5c0 1 1 1.2 1 2.3"/>',
    dice2: '<rect x="2.5" y="9" width="10" height="10" rx="2"/><path d="M14.5 6l5 1.3a2 2 0 0 1 1.4 2.5l-1.4 5.2"/><circle cx="5.5" cy="12" r=".9"/><circle cx="9.5" cy="16" r=".9"/><circle cx="7.5" cy="14" r=".9"/>',
    letter: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/><path d="M15 16h3"/>',
    tile: '<rect x="6" y="3" width="12" height="18" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M12 6.5v1M12 16.5v1"/>',
    spade: '<path d="M12 3c3 4 7 6.5 7 10a4 4 0 0 1-7 2.6A4 4 0 0 1 5 13c0-3.5 4-6 7-10z"/><path d="M12 15l-2 6h4z"/>',
  };
  const ICON_ORDER = ["house", "gem", "flag", "shuriken", "bubble", "moon", "shield", "dice"];
  const icon = (g, size = 28) => `<svg class="g-icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[g?.icon] || ICONS[ICON_ORDER[(g?.palette ?? 7) % ICON_ORDER.length]]}</svg>`;
  const color = g => (document.body && document.body.classList.contains("theme-guochao") ? INK : NEON)[(g?.palette ?? 0) % NEON.length];
  const diffPips = d => `<span class="pips" aria-label="难度 ${DIFF[d] || ""}">${[1, 2, 3].map(i => `<i class="${i <= d ? "on" : ""}"></i>`).join("")}</span>`;
  const fmtMin = s => (s ? `${Math.floor(s / 60)}:${pad(s % 60)}` : "");

  // ---------- Toast ----------
  function toast(message, kind = "info") {
    let host = $("#toastHost");
    if (!host) {
      host = document.createElement("div");
      host.id = "toastHost";
      host.className = "toast-host";
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = `toast toast-${kind}`;
    el.textContent = message;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));
    setTimeout(() => {
      el.classList.remove("show");
      setTimeout(() => el.remove(), 300);
    }, kind === "error" ? 5200 : 3200);
  }

  // ---------- 弹窗 ----------
  let lastFocus = null;
  function openModal(html, { wide = false, className = "" } = {}) {
    closeModal();
    lastFocus = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = `modal-backdrop ${className}`;
    wrap.id = "modal";
    wrap.innerHTML = `<div class="modal ${wide ? "modal-wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modalTitle" tabindex="-1"><button class="modal-x" type="button" data-close aria-label="关闭">×</button>${html}</div>`;
    wrap.addEventListener("click", e => {
      if (e.target === wrap || e.target.closest("[data-close]")) closeModal();
    });
    document.body.appendChild(wrap);
    document.body.classList.add("modal-open");
    requestAnimationFrame(() => {
      wrap.classList.add("show");
      $(".modal", wrap).focus();
    });
    return wrap;
  }
  function closeModal() {
    const m = $("#modal");
    if (!m) return;
    m.remove();
    document.body.classList.remove("modal-open");
    if (lastFocus && lastFocus.focus && document.contains(lastFocus)) lastFocus.focus();
  }
  document.addEventListener("keydown", e => {
    const m = $("#modal");
    if (!m) return;
    if (e.key === "Escape") return closeModal();
    if (e.key !== "Tab") return;
    const items = $('a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select, textarea, iframe, [tabindex]:not([tabindex="-1"])', m).filter(x => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || !m.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  function confirmDialog({ title, text, ok = "确定", danger = false }) {
    return new Promise(resolve => {
      const m = openModal(`<h2 id="modalTitle" class="modal-title">${esc(title)}</h2><p class="modal-text">${esc(text)}</p><div class="modal-actions"><button class="btn btn-ghost" type="button" data-no>再想想</button><button class="btn ${danger ? "btn-danger" : "btn-primary"}" type="button" data-yes>${esc(ok)}</button></div>`);
      const done = v => {
        closeModal();
        resolve(v);
      };
      $("[data-yes]", m).addEventListener("click", () => done(true));
      $("[data-no]", m).addEventListener("click", () => done(false));
      $(".modal-x", m).addEventListener("click", () => resolve(false));
    });
  }

  // ---------- 视频 ----------
  function videoBlock(g, { autoplay = false } = {}) {
    const v = g.video;
    if (!v) return `<div class="video-empty">暂无</div>`;
    const cover = v.cover ? `<img src="${esc(v.cover)}@640w_360h_1c.webp" alt="" loading="lazy" referrerpolicy="no-referrer" data-hide-on-error>` : "";
    return `<div class="video-shell" data-bvid="${esc(v.bvid)}">
      ${autoplay ? player(v.bvid) : `<button class="video-poster" type="button" data-play="${esc(v.bvid)}" aria-label="播放教学视频：${esc(v.title)}">${cover}<span class="play-btn"><svg viewBox="0 0 24 24" width="30" height="30"><path d="M8 5v14l11-7z" fill="currentColor"/></svg></span><span class="video-cap"><b>${esc(v.title || "教学视频")}</b><small>${esc(v.uploader ? `UP 主：${v.uploader}` : "")}${v.duration ? ` · ${fmtMin(v.duration)}` : ""}</small></span></button>`}
    </div>
    <div class="video-links"><a href="https://www.bilibili.com/video/${esc(v.bvid)}" target="_blank" rel="noopener">在 B 站打开 ↗</a>${g.videoBackup ? `<a href="https://www.bilibili.com/video/${esc(g.videoBackup.bvid)}" target="_blank" rel="noopener">备选教程：${esc(g.videoBackup.title || g.videoBackup.bvid)} ↗</a>` : ""}</div>`;
  }
  const player = bvid => `<iframe src="https://player.bilibili.com/player.html?bvid=${encodeURIComponent(bvid)}&autoplay=1&high_quality=1&danmaku=0" title="B 站教学视频" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"></iframe>`;
  document.addEventListener("error", e => {
    if (e.target && e.target.hasAttribute && e.target.hasAttribute("data-hide-on-error")) e.target.remove();
  }, true);
  document.addEventListener("click", e => {
    const btn = e.target.closest("[data-play]");
    if (!btn) return;
    const shell = btn.closest(".video-shell");
    shell.innerHTML = player(btn.dataset.play);
  });

  function rulesHtml(text) {
    const lines = String(text || "").split(/\n+/).map(s => s.trim()).filter(Boolean);
    if (!lines.length) return "<p>规则整理中。</p>";
    return `<ol class="rules">${lines.map(l => `<li>${esc(l.replace(/^\d+[.、．]\s*/, ""))}</li>`).join("")}</ol>`;
  }

  function openGame(g, { signupHref = "/signup", showSignup = true } = {}) {
    if (!g) return;
    const html = `<div class="gdetail" style="--c:${color(g)}">
      <header class="gdetail-head">
        <span class="gdetail-icon">${icon(g, 34)}</span>
        <div><h2 id="modalTitle" class="modal-title">${esc(g.name)}</h2>${g.en ? `<p class="gdetail-en">${esc(g.en)}</p>` : ""}
        <div class="meta-row"><span class="chip">${esc(g.category)}</span><span class="chip">👥 ${g.min}–${g.max} 人</span><span class="chip">⏱ 约 ${g.minutes} 分钟</span><span class="chip">难度 ${diffPips(g.difficulty)} ${DIFF[g.difficulty]}</span></div></div>
      </header>
      <p class="gdetail-intro">${esc(g.intro)}</p>
      ${g.notice ? `<p class="notice-line">⚠ ${esc(g.notice)}</p>` : ""}
      <section><h3 class="sec-h">▶ 教学视频</h3>${videoBlock(g)}</section>
      <section><h3 class="sec-h">规则速览</h3>${rulesHtml(g.rules)}<p class="fineprint">入门速览，细节以盒内说明书和现场讲解为准。</p></section>
      ${showSignup ? `<div class="modal-actions sticky-actions"><button class="btn btn-ghost" type="button" data-close>关闭</button><a class="btn btn-primary" href="${signupHref}?game=${encodeURIComponent(g.id)}">报名玩这个 →</a></div>` : ""}
    </div>`;
    openModal(html, { wide: true, className: "modal-game" });
  }

  function cardHtml(g, s) {
    const a = s?.alloc?.games?.[g.id];
    const info = a ? seatInfo(g, a) : null;
    const link = s && s.status === "open" && s.gameIds.includes(g.id) ? `/signup?session=${encodeURIComponent(s.id)}&game=${encodeURIComponent(g.id)}` : `/signup?game=${encodeURIComponent(g.id)}`;
    return `<article class="gcard" style="--c:${color(g)}" data-game="${esc(g.id)}">
      <button class="stretched" type="button" data-open="${esc(g.id)}" aria-label="查看「${esc(g.name)}」介绍和教学视频"></button>
      ${info ? `<span class="gcard-status pill pill-${info.tone}">${esc(info.short)}</span>` : ""}
      <div class="gcard-top"><div class="gcard-icon">${icon(g, 28)}</div><div><h3>${esc(g.name)}</h3>${g.en ? `<p class="gcard-en">${esc(g.en)}</p>` : ""}</div></div>
      <div class="gcard-meta"><span class="chip">${esc(g.category)}</span><span class="chip">👥 ${g.min}–${g.max}</span><span class="chip">⏱ ${g.minutes}′</span><span class="chip">${diffPips(g.difficulty)}</span></div>
      <p class="gcard-intro">${esc(g.intro)}</p>
      ${g.notice ? `<p class="notice-line">⚠ ${esc(g.notice)}</p>` : ""}
      <div class="gcard-foot">${g.video ? `<button class="btn btn-sm btn-ghost" type="button" data-open="${esc(g.id)}">▶ 教学视频</button>` : `<button class="btn btn-sm btn-ghost" type="button" data-open="${esc(g.id)}">规则速览</button>`}<a class="btn btn-sm" href="${link}">报名</a></div>
    </article>`;
  }
  // 卡片 3D 倾斜（仅鼠标）
  function bindCards(box) {
    box.addEventListener("pointermove", e => {
      if (e.pointerType !== "mouse" || reducedMotion()) return;
      const card = e.target.closest(".gcard");
      if (!card) return;
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      card.style.setProperty("--ry", `${(x - 0.5) * 10}deg`);
      card.style.setProperty("--rx", `${(0.5 - y) * 8}deg`);
      card.style.setProperty("--mx", `${x * 100}%`);
      card.style.setProperty("--my", `${y * 100}%`);
    });
    box.addEventListener(
      "pointerleave",
      e => {
        const card = e.target.closest && e.target.closest(".gcard");
        if (card) {
          card.style.setProperty("--rx", "0deg");
          card.style.setProperty("--ry", "0deg");
        }
      },
      true,
    );
    box.addEventListener("click", e => {
      const btn = e.target.closest("[data-open]");
      if (!btn) return;
      openGame(gameById(btn.dataset.open));
    });
  }


  // ---------- 日历 ----------
  const inWeChat = () => /MicroMessenger/i.test(navigator.userAgent);
  function downloadIcs(session, gameName) {
    if (inWeChat()) {
      toast("微信里无法直接添加日历：请点右上角「…」选择在浏览器打开，再点“加入日历”");
      return;
    }
    const dt = ms => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//kaizhuo//boardgame//CN", "CALSCALE:GREGORIAN", "BEGIN:VEVENT", `UID:${session.id}-${Date.now()}@kaizhuo`, `DTSTAMP:${dt(Date.now())}`, `DTSTART:${dt(session.startAt)}`, `DTEND:${dt(session.endAt)}`, `SUMMARY:桌游社 · 周五桌游夜${gameName ? `（${gameName}）` : ""}`, `LOCATION:${session.location}`, `DESCRIPTION:报名页面：${location.origin}/signup`, "BEGIN:VALARM", "TRIGGER:-PT60M", "ACTION:DISPLAY", "DESCRIPTION:桌游社活动 1 小时后开始", "END:VALARM", "END:VEVENT", "END:VCALENDAR"];
    const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `boardgame-${session.id}.ics`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  // ---------- 导航高亮 & Service Worker ----------
  function markNav() {
    const p = location.pathname.replace(/\.html$/, "").replace(/\/index$/, "/") || "/";
    $$("[data-nav]").forEach(a => a.classList.toggle("active", a.getAttribute("data-nav") === p));
  }
  document.addEventListener("DOMContentLoaded", markNav);
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
  }
  const reducedMotion = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;

  window.BGC = {
    $,
    $$,
    esc,
    store,
    api,
    boot,
    refresh,
    onState,
    setSnapshot,
    get snapshot() {
      return snapshot;
    },
    gameById,
    now,
    pad,
    fmtDate,
    relDay,
    splitDuration,
    fallbackSession,
    getMine,
    saveMine,
    liveStatus,
    inWeChat,
    get degraded() {
      return isDegraded;
    },
    removeMine,
    updateMine,
    placementOf,
    placementText,
    seatInfo,
    sessionLabel,
    icon,
    color,
    diffPips,
    DIFF,
    LEVELS,
    WEEKDAYS,
    GROUPS: ["身份类", "桌游", "特色"],
    NAME_KEY,
    toast,
    openModal,
    closeModal,
    confirmDialog,
    videoBlock,
    rulesHtml,
    openGame,
    cardHtml,
    bindCards,
    downloadIcs,
    reducedMotion,
  };
})();
