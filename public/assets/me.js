/* 我的报名：本浏览器里保存的报名 + 每轮分桌 + 同桌名单 + 找回 */
(function () {
  "use strict";
  const B = window.BGC;
  const { $, esc } = B;
  let snap = null;
  const gameName = id => B.gameById(id)?.name || id || "";

  function tableOf(session, pl) {
    if (pl.kind !== "seat") return null;
    const r = session.alloc.rounds.find(x => x.index === pl.round);
    const t = r?.games[pl.gameId]?.tables.find(x => x.no === pl.table);
    return t ? { r, t } : null;
  }
  function tablemates(session, pl) {
    const at = tableOf(session, pl);
    if (!at) return "";
    const others = at.t.players.filter(p => p.id !== pl.player.id).map(p => p.name);
    return others.length ? `同桌：${others.map(esc).join("、")}` : "";
  }
  // 我的讲规挂名（这台设备挂的、还在名单上的）
  function renderTeach() {
    const box = $("#myTeach");
    if (!box) return;
    const list = B.getMyTeach().filter(x => B.teachersOf(x.gameId).some(t => t.id === x.id));
    box.hidden = !list.length;
    box.innerHTML = list.length
      ? `<h2>我的讲规挂名</h2><p class="hint">这些挂名长期有效，显示在游戏库里。想提前学的同学可能会在群里问你；当晚哪桌没人会讲，也可能请你过去讲几分钟。</p>
        <ul class="teach-list">${list.map(x => `<li><span>🎓 ${esc(gameName(x.gameId))} <small>· ${esc(x.name)}</small></span><button class="teach-x" type="button" data-teach-del="${esc(x.id)}">撤下</button></li>`).join("")}</ul>`
      : "";
  }

  function card(m, s) {
    const pl = s ? B.placementOf(s, m.id) : null;
    const unsure = s && !pl && (B.degraded || snap.fromCache);
    const status = !s ? "已结束" : B.sessionLabel(s);
    const tone = !s ? "idle" : s.status === "open" ? "ok" : s.status === "live" ? "live" : s.status === "cancelled" ? "full" : "idle";
    const date = s ? `${B.fmtDate(s.date)} ${s.time} · ${s.location}` : m.sessionId;
    let body;
    if (m.pending && !pl && !unsure) body = `<p class="me-warn">上次提交时网络中断，这条报名没有成功，请重新报名。</p>`;
    else if (!s) body = `<p class="hint">这一场已经结束。</p>`;
    else if (!pl && unsure) body = `<p class="hint">正在同步报名状态…</p>`;
    else if (!pl) body = `<p class="me-warn">这条报名已被取消或移除（可能是组织者操作的）。</p>`;
    else
      body = `<ul class="me-rounds">${pl
        .map(p => {
          const mates = tablemates(s, p);
          const tag = p.kind === "seat" ? `<span class="pill pill-ok">${esc(gameName(p.gameId))} · 第 ${p.table} 桌</span>` : p.kind === "none" ? `<span class="pill pill-forming">暂未成桌</span>` : `<span class="pill pill-idle">不参加</span>`;
          const round = s.rounds.find(r => r.index === p.round);
          const at = tableOf(s, p);
          return `<li><div class="me-round-h"><b>${esc(p.label)}</b>${round && s.rounds.length > 1 ? `<span class="mono">${esc(round.start)}–${esc(round.end)}</span>` : ""}${tag}${p.kind === "seat" && p.rank > 1 ? `<small>第 ${p.rank} 志愿</small>` : ""}</div>${mates ? `<p class="hint">${mates}</p>` : p.kind === "none" ? `<p class="hint">你的志愿暂时凑不齐人。更多人报名后会自动重新分配；开局时组织者也会现场协调。多排几个志愿更容易成桌。</p>` : ""}${at ? B.teachNoteHtml(at.r, p.gameId, at.t) : ""}</li>`;
        })
        .join("")}</ul>`;
    const canEdit = s && s.status === "open" && pl;
    const prefs = (m.prefs || []).map((g, i) => `<span class="chip">${i + 1}. ${esc(gameName(g))}</span>`).join("");
    return `<article class="panel me-card">
      <header class="me-card-h"><div><h2>${esc(m.name || "我")}</h2><p class="hint">${esc(date)}</p></div><span class="pill pill-${tone}">${esc(status)}</span></header>
      ${prefs ? `<div class="me-prefs"><span class="hint">志愿顺序</span>${prefs}</div>` : ""}
      ${body}
      <div class="me-acts">
        ${canEdit ? `<a class="btn btn-sm btn-primary" href="/signup?session=${encodeURIComponent(s.id)}&edit=${encodeURIComponent(m.id)}">修改志愿 / 轮次</a><button class="btn btn-sm btn-danger" type="button" data-cancel="${esc(m.id)}">取消报名</button>` : ""}
        ${s && pl ? `<button class="btn btn-sm" type="button" data-ics="${esc(m.id)}">加入日历</button>` : ""}
        ${!pl && !unsure ? `<button class="btn btn-sm btn-ghost" type="button" data-forget="${esc(m.id)}">移除这条记录</button>` : ""}
      </div>
      ${s && pl && !m.hasPin && s.status === "open" ? `<p class="hint me-tip">提示：这条报名没设找回码，换浏览器后会看不到。可以点「修改」补一个 4 位找回码。</p>` : ""}
    </article>`;
  }

  function render() {
    if (!snap) return;
    renderTeach();
    const list = B.getMine();
    const box = $("#mineList");
    if (!list.length) {
      box.innerHTML = `<div class="panel me-empty"><h2>这个浏览器里还没有报名记录</h2><p class="hint">在这里报过名的话会显示在这里。换了浏览器的话，可以用下面的「找回报名」。</p><div class="me-acts"><a class="btn btn-primary" href="/signup">去报名</a><a class="btn btn-ghost" href="#recoverTitle">找回报名</a></div></div>`;
    } else {
      const upcoming = list.filter(m => snap.sessions.some(s => s.id === m.sessionId));
      const past = list.filter(m => !snap.sessions.some(s => s.id === m.sessionId));
      box.innerHTML = upcoming.map(m => card(m, snap.sessions.find(s => s.id === m.sessionId))).join("") + (past.length ? `<details class="me-past"><summary>已结束的场次（${past.length}）</summary>${past.map(m => card(m, null)).join("")}</details>` : "");
    }
    const sel = $("#rSession");
    const cur = sel.value;
    sel.innerHTML = snap.sessions.map(s => `<option value="${esc(s.id)}">${esc(B.fmtDate(s.date))} ${esc(s.time)}</option>`).join("");
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
  }

  async function recover(e) {
    e.preventDefault();
    const err = $("#rErr");
    err.textContent = "";
    const body = { sessionId: $("#rSession").value, name: $("#rName").value.trim(), pin: $("#rPin").value.trim() };
    if (!body.name || !/^\d{4}$/.test(body.pin)) {
      err.textContent = "请填写报名时的称呼和 4 位找回码";
      return;
    }
    const btn = $("#rBtn");
    btn.disabled = true;
    try {
      const res = await B.api("/api/signups/recover", { method: "POST", body });
      const r = res.signup;
      B.saveMine({ id: r.id, token: r.token, sessionId: r.sessionId, name: r.name, prefs: r.prefs, rounds: r.rounds, level: r.level, teach: r.teach, note: r.note, hasPin: true });
      B.store.set(B.NAME_KEY, r.name);
      B.setSnapshot(res.state);
      $("#rPin").value = "";
      B.toast("已找回，这个浏览器以后也能修改这条报名了", "ok");
      $("#mineList").scrollIntoView({ behavior: B.reducedMotion() ? "auto" : "smooth" });
    } catch (error) {
      err.textContent = error.message;
    } finally {
      btn.disabled = false;
    }
  }

  async function cancel(id) {
    const m = B.getMine().find(x => x.id === id);
    if (!m) return;
    const ok = await B.confirmDialog({ title: "取消这条报名？", text: `${m.name || ""} 的报名会被取消，名额让给其他同学。`, ok: "确认取消", danger: true });
    if (!ok) return;
    try {
      const res = await B.api(`/api/signups/${encodeURIComponent(id)}`, { method: "DELETE", token: m.token });
      B.removeMine(id);
      B.setSnapshot(res.state);
      B.toast("已取消报名", "ok");
    } catch (error) {
      B.toast(error.message, "error");
      if (error.status === 404) {
        B.removeMine(id);
        render();
      }
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("#recoverForm").addEventListener("submit", recover);
    $("#rPin").addEventListener("input", e => (e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4)));
    const last = B.store.get(B.NAME_KEY, "");
    if (last) $("#rName").value = last;
    document.addEventListener("click", e => {
      const t = e.target.closest("[data-cancel],[data-forget],[data-ics]");
      if (!t) return;
      if (t.dataset.cancel) cancel(t.dataset.cancel);
      else if (t.dataset.forget) {
        B.removeMine(t.dataset.forget);
        render();
      } else if (t.dataset.ics) {
        const m = B.getMine().find(x => x.id === t.dataset.ics);
        const s = m && snap.sessions.find(x => x.id === m.sessionId);
        if (s) B.downloadIcs(s, gameName((m.prefs || [])[0]));
      }
    });
    B.onState(data => {
      snap = data;
      render();
    });
    B.boot({ poll: 30000 }).catch(() => {
      if (!snap) $("#mineList").innerHTML = `<div class="panel me-empty"><h2>暂时连不上服务器</h2><p class="hint">请检查网络后刷新页面。</p></div>`;
    });
  });
})();
