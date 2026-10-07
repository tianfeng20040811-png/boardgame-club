/* 主页：星际跃迁背景 + 倒计时 + 实时战况 + 游戏舱 */
(function () {
  "use strict";
  const B = window.BGC;
  const { $, esc } = B;

  // ---------- 背景：星际跃迁 + 霓虹地平线网格 ----------
  function startSpace() {
    const canvas = $("#space");
    if (!canvas || !canvas.getContext) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let w = 0;
    let h = 0;
    let stars = [];
    let px = 0;
    let py = 0;
    let tx = 0;
    let ty = 0;
    let gridAlpha = 1;
    let running = true;
    let raf = 0;
    let last = 0;
    const COLORS = ["#ffffff", "#bfefff", "#22e5ff", "#ff9cf0", "#c9b8ff"];
    function resize() {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.round(Math.min(420, (w * h) / 4200));
      stars = Array.from({ length: count }, () => spawn(true));
    }
    function spawn(randomZ) {
      return { x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: randomZ ? Math.random() * 0.95 + 0.05 : 1, c: COLORS[(Math.random() * COLORS.length) | 0], pz: 0 };
    }
    function frame(t) {
      raf = 0;
      if (!running) return;
      const dt = Math.min(50, t - (last || t));
      last = t;
      px += (tx - px) * 0.04;
      py += (ty - py) * 0.04;
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2 + px * 40;
      const cy = h * 0.42 + py * 24;
      const fov = Math.max(w, h) * 0.55;
      const speed = 0.00018 * dt;
      // 星星
      for (const s of stars) {
        s.pz = s.z;
        s.z -= speed * (1.4 - s.z);
        if (s.z <= 0.02) {
          Object.assign(s, spawn(false));
          continue;
        }
        const sx = cx + (s.x / s.z) * fov * 0.5;
        const sy = cy + (s.y / s.z) * fov * 0.5;
        const ox = cx + (s.x / s.pz) * fov * 0.5;
        const oy = cy + (s.y / s.pz) * fov * 0.5;
        if (sx < -50 || sx > w + 50 || sy < -50 || sy > h + 50) {
          Object.assign(s, spawn(false));
          continue;
        }
        const a = Math.min(1, (1 - s.z) * 1.4);
        ctx.strokeStyle = s.c;
        ctx.globalAlpha = a;
        ctx.lineWidth = Math.max(0.6, (1 - s.z) * 2.2);
        ctx.beginPath();
        ctx.moveTo(ox, oy);
        ctx.lineTo(sx + 0.1, sy + 0.1);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      // 地平线网格
      if (gridAlpha > 0.02) {
        const horizon = h * 0.7;
        const vx = w / 2 + px * 60;
        ctx.save();
        ctx.globalAlpha = gridAlpha;
        const glow = ctx.createRadialGradient(vx, horizon, 0, vx, horizon, w * 0.6);
        glow.addColorStop(0, "rgba(255,43,214,0.35)");
        glow.addColorStop(0.4, "rgba(123,92,255,0.12)");
        glow.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(0, horizon - h * 0.3, w, h * 0.6);
        const grad = ctx.createLinearGradient(0, horizon, 0, h);
        grad.addColorStop(0, "rgba(255,43,214,0)");
        grad.addColorStop(0.25, "rgba(255,43,214,0.55)");
        grad.addColorStop(1, "rgba(34,229,255,0.75)");
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const lines = 22;
        for (let i = -lines; i <= lines; i++) {
          const bx = vx + (i / lines) * w * 2.2;
          ctx.moveTo(vx + (i / lines) * w * 0.05, horizon);
          ctx.lineTo(bx, h);
        }
        const offset = (t / 1800) % 1;
        for (let i = 0; i < 16; i++) {
          const z = (i + 1 - offset) / 16;
          const y = horizon + (h - horizon) * Math.pow(z, 2.4);
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
        }
        ctx.stroke();
        ctx.fillStyle = "rgba(255,120,240,0.85)";
        ctx.fillRect(0, horizon - 0.5, w, 1);
        ctx.restore();
      }
      if (!B.reducedMotion()) raf = requestAnimationFrame(frame);
    }
    function kick() {
      if (!raf && running) raf = requestAnimationFrame(frame);
    }
    resize();
    window.addEventListener("resize", () => {
      resize();
      kick();
    });
    window.addEventListener(
      "pointermove",
      e => {
        if (e.pointerType !== "mouse") return;
        tx = e.clientX / w - 0.5;
        ty = e.clientY / h - 0.5;
      },
      { passive: true },
    );
    window.addEventListener(
      "scroll",
      () => {
        gridAlpha = Math.max(0.12, 1 - window.scrollY / (h * 0.9));
        if (B.reducedMotion()) kick();
      },
      { passive: true },
    );
    document.addEventListener("visibilitychange", () => {
      running = document.visibilityState === "visible";
      if (running) {
        last = 0;
        kick();
      }
    });
    kick();
  }

  // ---------- 数据渲染 ----------
  let session = null;
  let nextOpen = null;
  function pickSessions(snap) {
    const list = snap?.sessions || [];
    const active = list.find(s => s.status === "open" || s.status === "live");
    const first = list[0] || null;
    return { first, active: active || first };
  }

  function renderAnnounce(snap) {
    const el = $("#announce");
    const text = snap?.settings?.announcement;
    el.hidden = !text;
    if (text) el.innerHTML = `<b>公告</b>${esc(text)}`;
  }

  function tick() {
    const s = session || B.fallbackSession();
    const box = $("#countdown");
    const status = $("#cdStatus");
    const digits = $("#cdDigits");
    const title = $("#cdTitle");
    const foot = $("#cdFoot");
    const loc = s.location || "R312";
    box.classList.toggle("is-live", s.status === "live");
    status.className = `pill ${s.status === "live" ? "pill-live" : s.status === "open" ? "pill-ok" : "pill-full"}`;
    status.textContent = s.fallback ? "离线预估" : B.sessionLabel(s);
    if (s.status === "live") {
      title.textContent = `${B.fmtDate(s.date)} · 正在进行`;
      const left = B.splitDuration(s.endAt - B.now());
      setDigits(digits, left, true);
      foot.innerHTML = `线上报名已截止 · 直接到 <b>${esc(loc)}</b> 找组织者加入`;
      return;
    }
    if (s.status === "cancelled") {
      title.textContent = `${B.fmtDate(s.date)} 停办`;
      setDigits(digits, null);
      foot.textContent = s.note ? `原因：${s.note}` : "这一周暂停一次，下一场照常。";
      return;
    }
    const left = B.splitDuration(s.startAt - B.now());
    title.textContent = `${B.fmtDate(s.date)} · ${s.time} · ${loc}`;
    setDigits(digits, left, false);
    const count = s.alloc?.totals?.signups ?? 0;
    foot.innerHTML = s.fallback ? "正在连接服务器获取报名情况…" : `${(s.rounds || []).map(r => `第${r.index}轮 ${r.start}–${r.end}`).join(" · ")} · 已报名 <b>${count}</b> 人`;
  }
  function setDigits(el, t, live) {
    const parts = el.querySelectorAll("b");
    const labels = el.querySelectorAll("small");
    if (!t) {
      parts.forEach(b => (b.textContent = "--"));
      return;
    }
    const vals = live ? [t.h, t.m, t.s, null] : [t.d, t.h, t.m, t.s];
    const names = live ? ["时", "分", "秒", ""] : ["天", "时", "分", "秒"];
    vals.forEach((v, i) => {
      parts[i].textContent = v === null ? "▶" : B.pad(v);
      labels[i].textContent = live && i === 3 ? "进行中" : names[i];
    });
    el.setAttribute("aria-label", live ? `距离结束 ${t.h} 小时 ${t.m} 分` : `距离开局 ${t.d} 天 ${t.h} 小时 ${t.m} 分`);
  }

  function animateNumber(el, to) {
    const from = Number(el.dataset.v || 0);
    el.dataset.v = to;
    if (B.reducedMotion() || from === to) {
      el.textContent = to;
      return;
    }
    const start = performance.now();
    const step = t => {
      const p = Math.min(1, (t - start) / 700);
      el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function renderStats(s) {
    const a = s?.alloc;
    const vals = { signups: a?.totals.signups || 0, tables: a?.totals.tablesReady || 0, rounds: s?.rounds?.length || 2, games: s?.gameIds?.length || 0 };
    document.querySelectorAll("[data-stat]").forEach(el => animateNumber(el, vals[el.dataset.stat] ?? 0));
  }

  function renderBoard(snap, s) {
    const box = $("#boardList");
    const sub = $("#boardSub");
    if (!s) return;
    const rounds = s.alloc?.rounds || [];
    const roundsText = rounds.map(r => `第${r.index}轮 ${r.start}–${r.end}`).join(" · ");
    sub.textContent = `${B.fmtDate(s.date)} · ${s.location} · ${roundsText}。${s.status === "open" ? "每人按志愿顺序分桌，凑不齐的游戏会把人顺延到下一个志愿；每轮换一款不重复的游戏。" : s.status === "live" ? "活动进行中，以下为锁定后的分桌。" : ""}`;
    if (s.status === "cancelled") {
      box.innerHTML = `<div class="board-empty"><b>${esc(B.fmtDate(s.date))} 停办</b>${esc(s.note || "这一周暂停一次")}${snap.sessions[1] ? ` · 下一场：${esc(B.fmtDate(snap.sessions.find(x => x.status === "open")?.date || snap.sessions[1].date))}` : ""}</div>`;
      return;
    }
    const interest = s.alloc?.interest || {};
    const rows = (s.allGameIds || s.gameIds)
      .map(id => ({ g: B.gameById(id), it: interest[id] || { first: 0, any: 0 } }))
      .filter(x => x.g)
      .sort((x, y) => y.it.any - x.it.any || y.it.first - x.it.first || x.g.name.localeCompare(y.g.name, "zh"));
    if (!rows.length) {
      box.innerHTML = `<div class="board-empty"><b>本场还没有开放游戏</b>组织者稍后会更新</div>`;
      return;
    }
    const href = id => `/signup?session=${encodeURIComponent(s.id)}&game=${encodeURIComponent(id)}`;
    box.innerHTML = rows
      .map(({ g, it }) => {
        const info = B.seatInfo(g, s);
        const pct = Math.min(100, (it.any / Math.max(g.min, 1)) * 100);
        const perRound = rounds.map(r => {
          const ga = r.games[g.id];
          const n = ga ? ga.count : 0;
          return `<span class="round-chip ${n ? "on" : ""}">第${r.index}轮 ${n ? `${n} 人·${ga.tables.length} 桌` : "—"}</span>`;
        });
        const open = s.gameIds.includes(g.id);
        return `<article class="board-row" style="--c:${B.color(g)}">
          <div class="board-icon">${B.icon(g, 26)}</div>
          <div class="board-name"><b>${esc(g.name)}</b><small>${g.min}–${g.max} 人 · 约 ${g.minutes} 分钟</small></div>
          <div class="board-meter"><div class="meter" role="img" aria-label="${esc(g.name)}：意向 ${it.any} 人，最少 ${g.min} 人成桌"><span style="width:${pct}%"></span><i style="left:100%" title="成桌最少人数"></i></div>
            <div class="meter-txt"><span>首选 <span class="mono">${it.first}</span> · 意向 <span class="mono">${it.any}</span> 人</span><span>${rounds.length > 1 ? perRound.join("") : esc(info.text)}</span></div></div>
          <div class="board-act"><span class="pill pill-${info.tone}">${esc(info.short || "可报名")}</span>${s.status === "open" && open ? `<a class="btn btn-sm ${info.tone === "forming" ? "btn-primary" : ""}" href="${href(g.id)}">加入</a>` : ""}</div>
        </article>`;
      })
      .join("");
  }

  function renderCards(snap, s) {
    const box = $("#gameCards");
    const games = (snap?.games || []).filter(g => g.active);
    if (!games.length) {
      box.innerHTML = `<div class="board-empty">游戏库加载中…</div>`;
      return;
    }
    const groups = [...B.GROUPS, ...new Set(games.map(g => g.group).filter(x => !B.GROUPS.includes(x)))];
    box.innerHTML = groups
      .map(name => {
        const list = games.filter(g => g.group === name);
        return list.length ? `<h3 class="group-h"><span>${esc(name)}</span><small>${list.length} 款</small></h3>${list.map(g => B.cardHtml(g, s)).join("")}` : "";
      })
      .join("");
  }

  function renderMine(snap) {
    const box = $("#mine");
    const rows = [];
    for (const m of B.getMine()) {
      const s = snap.sessions.find(x => x.id === m.sessionId);
      if (!s) continue;
      const pl = B.placementOf(s, m.id);
      if (!pl) continue;
      rows.push(`<div class="mine-item"><b>✔ 已报名</b><span>${esc(B.fmtDate(s.date))} · ${esc(B.placementText(pl))}</span><a href="/me">我的报名</a></div>`);
      if (rows.length >= 2) break;
    }
    box.hidden = !rows.length;
    box.innerHTML = rows.join("");
  }

  function render(snap) {
    const picked = pickSessions(snap);
    session = picked.first && picked.first.status === "cancelled" ? picked.first : picked.active;
    nextOpen = picked.active;
    renderAnnounce(snap);
    tick();
    renderStats(picked.active);
    renderBoard(snap, picked.active);
    renderCards(snap, picked.active);
    renderMine(snap);
  }

  document.addEventListener("DOMContentLoaded", () => {
    startSpace();
    B.bindCards($("#gameCards"));
    tick();
    setInterval(tick, 1000);
    B.onState(render);
    B.boot().catch(() => {});
  });
})();
