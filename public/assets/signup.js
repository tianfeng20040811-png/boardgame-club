/* 报名页：选场次 → 选游戏 → 填信息 → 提交；本机可修改 / 取消；公开名单与分桌 */
(function () {
  "use strict";
  const B = window.BGC;
  const { $, $$, esc } = B;
  const params = new URLSearchParams(location.search);
  let snap = null;
  let sessionId = null;
  let selGame = params.get("game") || "";
  const wantedSession = params.get("session");
  let editing = null; // 正在修改的本机报名记录
  let renderedKey = "";
  let busy = false;
  let lastShownId = "";
  let forFriend = false;
  let pendingCreate = null; // 网络中断时重试复用同一个 id 和凭证
  function setHTML(el, html) {
    if (!el || el._html === html) return false;
    el._html = html;
    el.innerHTML = html;
    return true;
  }
  const randHex = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, "0")).join("");
  // 32 位 base64url 凭证（服务端要求 22–64 位的 [A-Za-z0-9_-]）
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const randToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), b => B64[b & 63]).join("");

  const session = () => snap?.sessions.find(s => s.id === sessionId) || null;
  const isOpen = s => s && s.status === "open";
  const gameName = id => B.gameById(id)?.name || "";

  // ---------- 角色气泡 ----------
  function say(text) {
    for (const el of [$("#bubble"), $("#bubbleM")]) {
      if (!el) continue;
      el.textContent = text;
      el.classList.remove("pop");
      void el.offsetWidth;
      el.classList.add("pop");
    }
  }
  function cheer() {
    document.body.classList.add("cheer");
    setTimeout(() => document.body.classList.remove("cheer"), 2300);
  }

  // ---------- 场次 ----------
  function pickSession() {
    if (!snap) return;
    if (editing) {
      sessionId = editing.sessionId;
      return;
    }
    if (sessionId && snap.sessions.some(s => s.id === sessionId)) return;
    if (wantedSession && snap.sessions.some(s => s.id === wantedSession)) sessionId = wantedSession;
    else sessionId = (snap.sessions.find(s => s.status === "open") || snap.sessions[0])?.id || null;
  }
  function renderSessions() {
    const box = $("#sessions");
    if (!snap.sessions.length) {
      setHTML(box, `<div class="notice">暂时没有可报名的场次，请稍后再来。</div>`);
      return;
    }
    setHTML(box, snap.sessions
      .map(s => {
        const off = s.status === "cancelled" || s.status === "ended";
        const sub = s.status === "open" ? `已报 ${s.alloc.totals.signups} 人` : B.sessionLabel(s);
        const place = s.location !== snap.settings.location ? ` · ${esc(s.location)}` : "";
        return `<button type="button" class="sess ${off ? "off" : ""}" role="radio" aria-checked="${s.id === sessionId}" data-sid="${esc(s.id)}">
          <span class="sess-tag">${esc(s.title || B.relDay(s.date, snap.settings.tzOffsetMinutes))}${s.extra ? " · 加场" : ""}</span>
          <b>${esc(B.fmtDate(s.date))} ${esc(s.time)}</b>
          <small>${esc(sub)}${place}</small>
        </button>`;
      })
      .join(""));
  }
  function renderNotice(s) {
    const el = $("#sessionNotice");
    let html = "";
    if (!s) html = "暂时没有可报名的场次。";
    else if (s.status === "cancelled") html = `${esc(B.fmtDate(s.date))} 停办${s.note ? `：${esc(s.note)}` : ""}。请选择其他场次。`;
    else if (s.status === "live") html = `活动正在进行，线上报名已截止。可以直接到 ${esc(s.location)} 找组织者现场加入。`;
    else if (s.status === "ended") html = "这一场已经结束了，请选择其他场次。";
    else {
      const bits = [];
      if (s.location !== snap.settings.location) bits.push(`本场地点：${esc(s.location)}`);
      if (s.time !== snap.settings.time) bits.push(`本场开始时间：${esc(s.time)}`);
      if (s.note) bits.push(`组织者备注：${esc(s.note)}`);
      html = bits.join("<br>");
    }
    el.hidden = !html;
    setHTML(el, html);
    $("#locLabel").textContent = s?.location || snap?.settings.location || "R312";
  }

  // ---------- 游戏选项 ----------
  function renderGames(s) {
    const box = $("#gameOptions");
    if (!s) {
      box.innerHTML = "";
      return;
    }
    const allowedIds = editing && editing.sessionId === s.id ? [...new Set([...s.gameIds, editing.gameId].filter(Boolean))] : s.gameIds;
    const games = allowedIds.map(B.gameById).filter(Boolean);
    if (selGame && !allowedIds.includes(selGame)) selGame = "";
    const groups = [...B.GROUPS, ...new Set(games.map(g => g.group).filter(x => !B.GROUPS.includes(x)))];
    const multi = groups.filter(gr => games.some(g => g.group === gr)).length > 1;
    // 重绘前记住键盘焦点所在的选项，重绘后放回去
    const active = document.activeElement;
    const focusSel = active && box.contains(active) ? (active.name === "gameId" ? `input[value="${CSS.escape(active.value)}"]` : active.dataset.open ? `[data-open="${CSS.escape(active.dataset.open)}"]` : "") : "";
    const changed = setHTML(box, groups
      .map(gr => {
        const list = games.filter(g => g.group === gr);
        if (!list.length) return "";
        return `${multi ? `<div class="gopt-group">${esc(gr)}</div>` : ""}${list
          .map(g => {
            const a = s.alloc.games[g.id];
            const info = B.seatInfo(g, a);
            return `<label class="gopt" style="--c:${B.color(g)}">
              <input type="radio" name="gameId" value="${esc(g.id)}" ${g.id === selGame ? "checked" : ""}>
              <span class="gopt-body">
                <span class="gopt-icon">${B.icon(g, 24)}</span>
                <span class="gopt-name">${esc(g.name)}</span>
                <span class="gopt-meta">${g.min}–${g.max}人 · ${g.minutes}分钟 · ${B.DIFF[g.difficulty]}</span>
                ${g.notice ? `<span class="gopt-warn">⚠ ${esc(g.notice)}</span>` : ""}
                <span class="gopt-seat pill pill-${info.tone}" title="${esc(info.text)}">${esc(info.short.replace("满员·可候补", "满员·候补"))}</span>
              </span>
              <button type="button" class="gopt-video" data-open="${esc(g.id)}" aria-label="查看${esc(g.name)}的教学视频和规则">${g.video ? "▶ 教学" : "规则"}</button>
            </label>`;
          })
          .join("")}`;
      })
      .join(""));
    if (changed && focusSel) $(focusSel, box)?.focus({ preventScroll: true });
  }
  function renderAlt(s) {
    const sel = $("#altGameId");
    if (document.activeElement === sel) return; // 用户正在选，别把下拉框关掉
    const current = sel.value;
    const opts = (s?.gameIds || [])
      .filter(id => id !== selGame)
      .map(B.gameById)
      .filter(Boolean)
      .map(g => {
        const info = B.seatInfo(g, s.alloc.games[g.id]);
        return `<option value="${esc(g.id)}">${esc(g.name)}（${esc(info.short || `${g.min}–${g.max}人`)}）</option>`;
      });
    sel.innerHTML = `<option value="">不需要，只玩第一志愿</option>${opts.join("")}`;
    sel.value = [...sel.options].some(o => o.value === current) ? current : "";
  }

  // ---------- 汇总 / 预测 ----------
  function predict(s, gid) {
    const a = s.alloc.games[gid];
    if (!a) return "";
    if (editing && editing.gameId === gid) return "保存后保留你原来的排队顺序";
    const requeue = editing ? "换游戏会按修改时间重新排队；" : "";
    const alt = $("#altGameId").value;
    if (a.seatsLeft <= 0) return requeue + (alt ? `已满员，会先尝试第二志愿「${esc(gameName(alt))}」，否则候补` : "已满员，将进入候补，有人取消会自动补位");
    if (a.status === "empty") return requeue + (a.min > 1 ? `你是第一位！还需 ${a.min - 1} 人成桌` : "你是第一位！");
    if (a.status === "forming") return requeue + (a.need - 1 > 0 ? `加入后还差 ${a.need - 1} 人成桌` : "你一加入就能成桌 🎉");
    return requeue + `有空位，当前余 ${a.seatsLeft} 座`;
  }
  function renderSummary() {
    const s = session();
    const btn = $("#submitBtn");
    const out = $("#summary");
    btn.textContent = editing ? "保存修改" : "确认报名";
    if (!s || !isOpen(s)) {
      out.textContent = s ? `${B.fmtDate(s.date)} 不在报名时间内` : "暂无可报名场次";
      btn.disabled = true;
      return;
    }
    btn.disabled = busy;
    if (!selGame) {
      out.innerHTML = `<b>${esc(B.fmtDate(s.date))} ${esc(s.time)}</b> · ${esc(s.location)}<br>先在上面选一款游戏`;
      return;
    }
    out.innerHTML = `<b>${esc(B.fmtDate(s.date))} ${esc(s.time)} · ${esc(gameName(selGame))}</b><br>${predict(s, selGame)}`;
  }
  function setFormEnabled(on) {
    $$("#form fieldset").forEach(f => (f.disabled = !on));
  }
  function updateLevelUI() {
    const lv = $("input[name=level]:checked")?.value;
    $("#levelGame").textContent = selGame ? `「${gameName(selGame)}」` : "这款游戏";
    $("#teachRow").hidden = lv === undefined || lv === "0";
  }

  // ---------- 我的报名 ----------
  function renderMine() {
    const box = $("#mine");
    const list = B.getMine();
    const rows = [];
    for (const m of list) {
      const s = snap.sessions.find(x => x.id === m.sessionId);
      if (!s) {
        if (Date.now() - (m.savedAt || 0) > 30 * 86400000) B.removeMine(m.id);
        continue;
      }
      const pl = B.placementOf(s, m.id);
      const canEdit = isOpen(s) && pl;
      const unsure = !pl && (B.degraded || snap.fromCache);
      if (m.pending && !pl && !unsure) {
        rows.push(`<div class="mine-row"><div><b>${esc(m.name || "")} · ${esc(B.fmtDate(s.date))} ${esc(s.time)}</b><p>上次提交时网络中断，没有报名成功，请重新提交</p></div><div class="mine-acts"><button class="btn btn-xs" type="button" data-forget="${esc(m.id)}">知道了</button></div></div>`);
        continue;
      }
      if (m.pending && pl) B.updateMine(m.id, { pending: false });
      rows.push(`<div class="mine-row">
        <div><b>${esc(m.name || "")} · ${esc(B.fmtDate(s.date))} ${esc(s.time)}</b>
        <p>${pl ? esc(B.placementText(pl)) : unsure ? "正在同步报名状态…" : "这条报名已被取消或移除"}${s.status === "cancelled" ? " · 本场停办" : ""}</p></div>
        <div class="mine-acts">${canEdit ? `<button class="btn btn-xs" type="button" data-edit="${esc(m.id)}">修改</button><button class="btn btn-xs btn-danger" type="button" data-cancel="${esc(m.id)}">取消</button>` : ""}${!pl && !unsure ? `<button class="btn btn-xs" type="button" data-forget="${esc(m.id)}">移除记录</button>` : ""}</div>
      </div>`);
    }
    box.hidden = !rows.length;
    setHTML($("#mineList"), rows.join(""));
  }

  // ---------- 名单 ----------
  function renderRoster(s) {
    const body = $("#rosterBody");
    if (!s) {
      setHTML(body, "");
      return;
    }
    const mine = new Set(B.getMine().map(m => m.id));
    $("#rosterTitle").textContent = `${B.fmtDate(s.date)} 名单与分桌 · ${s.alloc.totals.signups} 人`;
    const blocks = (s.allGameIds || s.gameIds)
      .map(id => ({ g: B.gameById(id), a: s.alloc.games[id] }))
      .filter(x => x.g && x.a && (x.a.count || x.a.waitlist.length))
      .sort((x, y) => y.a.count - x.a.count)
      .map(({ g, a }) => {
        const tables = a.tables
          .map(t => {
            const names = t.players.map(p => `<span class="name ${mine.has(p.id) ? "me" : ""}">${p.teach || p.level === 2 ? "🎓" : p.level === 0 ? "🌱" : ""}${esc(p.name)}${p.via === "alt" ? " ↪" : ""}</span>`).join("");
            const empties = t.short > 0 ? Array.from({ length: Math.min(t.short, 6) }, () => `<span class="name empty">虚位以待</span>`).join("") : "";
            return `<div class="rtable"><div class="rtable-h"><b>第 ${t.no} 桌</b><span>${t.players.length} 人${t.short ? ` · 还差 ${t.short} 人成桌` : " · 已成桌"}</span></div><div class="names">${names}${empties}</div></div>`;
          })
          .join("");
        const wait = a.waitlist.length ? `<p class="wait-line">候补：${a.waitlist.map(p => esc(p.name)).join("、")}</p>` : "";
        return `<div class="roster-game" style="--c:${B.color(g)}"><h3><span class="gi">${B.icon(g, 20)}</span>${esc(g.name)} <span class="pill pill-${B.seatInfo(g, a).tone}">${esc(B.seatInfo(g, a).short)}</span></h3><div class="roster-tables">${tables}</div>${wait}</div>`;
      });
    setHTML(body, blocks.length
      ? `${blocks.join("")}<p class="legend"><span>🎓 熟练 / 愿意教学</span><span>🌱 新手</span><span>↪ 按第二志愿安排</span><span>分桌随报名实时调整，开局时以此为准</span></p>`
      : `<p class="roster-empty">还没有人报名，快来当第一个！</p>`);
  }

  // ---------- 总渲染 ----------
  function render(force) {
    if (!snap) return;
    pickSession();
    const s = session();
    const key = `${snap.revision}|${sessionId}|${s?.status}|${editing?.id || ""}`;
    renderSessions();
    renderNotice(s);
    renderMine();
    renderRoster(s);
    if (force || key !== renderedKey) {
      renderedKey = key;
      renderGames(s);
      renderAlt(s);
    }
    setFormEnabled(isOpen(s));
    updateLevelUI();
    renderSummary();
  }

  // ---------- 表单 ----------
  function clearErrors() {
    ["#errGame", "#errName", "#errLevel"].forEach(id => ($(id).textContent = ""));
    $("#name").removeAttribute("aria-invalid");
  }
  function collect() {
    const lv = $("input[name=level]:checked");
    return {
      sessionId,
      gameId: selGame,
      altGameId: $("#altGameId").value,
      name: $("#name").value.trim(),
      level: lv ? Number(lv.value) : null,
      teach: $("#teach").checked && !$("#teachRow").hidden,
      note: $("#note").value.trim(),
      website: $("input[name=website]").value,
    };
  }
  function validate(d) {
    clearErrors();
    let first = null;
    if (!d.gameId) {
      $("#errGame").textContent = "请选择一款想玩的游戏";
      if (!first) first = $("#stepGame");
    }
    if (!d.name) {
      $("#errName").textContent = "请填写称呼";
      $("#name").setAttribute("aria-invalid", "true");
      if (!first) first = $("#name");
    }
    if (d.level === null) {
      $("#errLevel").textContent = "请选择熟悉程度，方便安排会教的人带你";
      if (!first) first = $("#levelSeg");
    }
    if (first) {
      first.scrollIntoView({ behavior: B.reducedMotion() ? "auto" : "smooth", block: "center" });
      if (first.focus && first.tagName === "INPUT") setTimeout(() => first.focus(), 300);
      return false;
    }
    return true;
  }
  function setBusy(on) {
    busy = on;
    const btn = $("#submitBtn");
    btn.classList.toggle("is-loading", on);
    btn.disabled = on;
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const s = session();
    if (!isOpen(s)) return B.toast("这一场现在不能报名", "error");
    const d = collect();
    if (!validate(d)) return;
    setBusy(true);
    try {
      let res;
      if (editing) {
        res = await B.api(`/api/signups/${encodeURIComponent(editing.id)}`, { method: "PATCH", token: editing.token, body: d });
        B.updateMine(editing.id, { name: d.name, gameId: d.gameId, altGameId: d.altGameId, level: d.level, teach: d.teach, note: d.note });
        const id = editing.id;
        editing = null;
        B.setSnapshot(res.state);
        showSuccess(id, true);
      } else {
        const sig = JSON.stringify(d);
        if (!pendingCreate || pendingCreate.sig !== sig) pendingCreate = { sig, id: `s${randHex(6)}`, token: randToken() };
        const { id, token } = pendingCreate;
        B.saveMine({ id, token, sessionId: d.sessionId, name: d.name, gameId: d.gameId, altGameId: d.altGameId, level: d.level, teach: d.teach, note: d.note, pending: true });
        try {
          res = await B.api("/api/signups", { method: "POST", body: { ...d, id, token } });
        } catch (error) {
          // 明确被拒绝（4xx）就删掉这条待确认记录；网络问题则保留，方便重试或稍后核对
          if (error.status >= 400 && error.status < 500) {
            B.removeMine(id);
            pendingCreate = null;
          } else if (!error.status) error.message = "网络中断，没能确认是否报名成功。可以直接再点一次提交（不会重复报名）";
          throw error;
        }
        pendingCreate = null;
        B.updateMine(id, { pending: false, id: res.signup.id, sessionId: res.signup.sessionId });
        if (!forFriend) B.store.set(B.NAME_KEY, d.name);
        B.setSnapshot(res.state);
        showSuccess(res.signup.id, false);
      }
    } catch (error) {
      if (error.status === 409 && /称呼|报名过/.test(error.message)) {
        $("#errName").textContent = error.message;
        $("#name").setAttribute("aria-invalid", "true");
        $("#name").focus();
      }
      B.toast(error.message, "error");
      if (error.status === 409 || error.status === 400) B.refresh().catch(() => {});
    } finally {
      setBusy(false);
      renderSummary();
    }
  }

  function showSuccess(id, edited) {
    lastShownId = id;
    const s = snap.sessions.find(x => x.alloc && B.placementOf(x, id)) || session();
    const pl = s ? B.placementOf(s, id) : null;
    const m = B.getMine().find(x => x.id === id) || {};
    const box = $("#success");
    box.innerHTML = `
      <h2>${edited ? "修改成功" : "报名成功！"}</h2>
      <p>${esc(m.name || "")}，${esc(B.fmtDate(s.date))} ${esc(s.time)} ${esc(s.location)} 见～</p>
      <div class="ticket">
        <div class="ticket-head"><span>上桌凭证</span><small>${esc(s.date)}</small></div>
        <div class="ticket-body">
          <div><small>时间</small><b>${esc(B.fmtDate(s.date))} ${esc(s.time)}</b></div>
          <div><small>地点</small><b>${esc(s.location)}</b></div>
          <div><small>第一志愿</small><b>${esc(gameName(m.gameId))}</b></div>
          <div><small>第二志愿</small><b>${esc(m.altGameId ? gameName(m.altGameId) : "—")}</b></div>
          <div class="full"><small>当前分桌（随报名实时调整）</small><b>${esc(B.placementText(pl))}</b></div>
        </div>
      </div>
      <div class="ticket-actions">
        <button class="btn btn-red" type="button" data-again>再帮朋友报一位</button>
        <button class="btn" type="button" data-ics>加入日历</button>
        <button class="btn" type="button" data-edit="${esc(id)}">修改</button>
        <button class="btn btn-ghost" type="button" data-roster>看名单</button>
      </div>
      <p class="hint">修改或取消：用这台设备上的同一个浏览器（在微信里报的就用微信）打开本页，在“我的报名”里操作。</p>`;
    box.hidden = false;
    $("#form").hidden = true;
    $("#formHead").hidden = true;
    box.focus({ preventScroll: true });
    box.scrollIntoView({ behavior: B.reducedMotion() ? "auto" : "smooth", block: "start" });
    say(edited ? "已改妥。周五，R312 见。" : `报名成功——${gameName(m.gameId)}，周五见。`);
    cheer();
    if (window.FX) {
      setTimeout(() => FX.burstAt($(".ticket", box), { count: 90, power: 1.2 }), 350);
      setTimeout(() => FX.burstAt($(".ticket-head", box), { count: 50, power: 0.8, colors: ["255,230,160", "255,140,70", "140,255,210"] }), 750);
    }
    render(true);
  }

  function resetForm({ keepGame = true } = {}) {
    clearErrors();
    $("#name").value = "";
    $$("input[name=level]").forEach(r => (r.checked = false));
    $("#teach").checked = false;
    $("#note").value = "";
    $("#altGameId").value = "";
    if (!keepGame) selGame = "";
  }

  function startEdit(id) {
    const m = B.getMine().find(x => x.id === id);
    if (!m) return;
    const s = snap.sessions.find(x => x.id === m.sessionId);
    if (!isOpen(s)) return B.toast("这一场已经不能在线修改了", "error");
    editing = m;
    sessionId = m.sessionId;
    selGame = m.gameId || "";
    render(true);
    $("#name").value = m.name || "";
    const pl = B.placementOf(s, id);
    const level = m.level ?? pl?.player?.level;
    $$("input[name=level]").forEach(r => (r.checked = String(r.value) === String(level)));
    $("#teach").checked = Boolean(m.teach ?? pl?.player?.teach);
    $("#note").value = m.note || "";
    renderAlt(s);
    $("#altGameId").value = m.altGameId || "";
    $("#success").hidden = true;
    $("#form").hidden = false;
    $("#formHead").hidden = false;
    updateLevelUI();
    renderSummary();
    $("#form").scrollIntoView({ behavior: B.reducedMotion() ? "auto" : "smooth", block: "start" });
    $("#name").focus({ preventScroll: true });
  }
  function stopEdit() {
    editing = null;
    $("#formHead").hidden = true;
    resetForm();
    const last = B.store.get(B.NAME_KEY, "");
    if (last) $("#name").value = last;
    render(true);
  }

  async function cancelSignup(id) {
    const m = B.getMine().find(x => x.id === id);
    if (!m) return;
    const ok = await B.confirmDialog({ title: "取消这条报名？", text: `${m.name || ""} · ${gameName(m.gameId)}。取消后座位会让给候补的同学。`, ok: "确认取消", danger: true });
    if (!ok) return;
    try {
      const res = await B.api(`/api/signups/${encodeURIComponent(id)}`, { method: "DELETE", token: m.token });
      B.removeMine(id);
      if (editing && editing.id === id) stopEdit();
      B.setSnapshot(res.state);
      $("#success").hidden = true;
      $("#form").hidden = false;
      B.toast("已取消报名", "ok");
      say("已取消。江湖路远，下次再会。");
    } catch (error) {
      B.toast(error.message, "error");
      if (error.status === 404) {
        B.removeMine(id);
        render(true);
      }
    }
  }

  // ---------- 事件 ----------
  function bind() {
    $("#sessions").addEventListener("click", e => {
      const b = e.target.closest(".sess");
      if (!b) return;
      if (editing && b.dataset.sid !== editing.sessionId) return B.toast("修改报名时不能换场次；如需改场次，请取消后重新报名");
      sessionId = b.dataset.sid;
      $("#success").hidden = true;
      $("#form").hidden = false;
      render(true);
    });
    $("#gameOptions").addEventListener("change", e => {
      if (e.target.name !== "gameId") return;
      selGame = e.target.value;
      $("#errGame").textContent = "";
      renderAlt(session());
      updateLevelUI();
      renderSummary();
      const a = session()?.alloc.games[selGame];
      say(a && a.status === "full" ? "此桌已满——选个第二志愿，进退有据。" : `「${gameName(selGame)}」，好眼光。`);
      if (window.FX) FX.burstAt(e.target.closest(".gopt")?.querySelector(".gopt-body"), { count: 26, power: 0.45 });
    });
    $("#gameOptions").addEventListener("click", e => {
      const b = e.target.closest("[data-open]");
      if (!b) return;
      e.preventDefault();
      B.openGame(B.gameById(b.dataset.open), { showSignup: false });
    });
    $("#levelSeg").addEventListener("change", e => {
      $("#errLevel").textContent = "";
      const lv = e.target.value;
      if (lv === "2") $("#teach").checked = true;
      updateLevelUI();
      say(lv === "0" ? "初入此道？放心，自有高手带你。" : lv === "2" ? "高手驾到——愿意带带新人吗？" : "老手了，开局不用等。");
    });
    $("#teach").addEventListener("change", e => e.target.checked && say("传道授业，功德无量。"));
    $("#altGameId").addEventListener("change", renderSummary);
    $("#name").addEventListener("input", () => {
      $("#errName").textContent = "";
      $("#name").removeAttribute("aria-invalid");
    });
    $("#form").addEventListener("submit", submit);
    $("#cancelEdit").addEventListener("click", stopEdit);
    document.addEventListener("click", e => {
      const t = e.target.closest("[data-edit],[data-cancel],[data-forget],[data-again],[data-ics],[data-roster]");
      if (!t) return;
      if (t.dataset.edit) startEdit(t.dataset.edit);
      else if (t.dataset.cancel) cancelSignup(t.dataset.cancel);
      else if (t.dataset.forget) {
        B.removeMine(t.dataset.forget);
        render(true);
      } else if (t.hasAttribute("data-again")) {
        forFriend = true; // 帮朋友报名：不要把朋友的称呼记成“我的称呼”
        resetForm({ keepGame: true });
        $("#success").hidden = true;
        $("#form").hidden = false;
        render(true);
        $("#name").focus();
        $("#form").scrollIntoView({ behavior: B.reducedMotion() ? "auto" : "smooth", block: "start" });
        say("再添一位——填上朋友的称呼。");
      } else if (t.hasAttribute("data-ics")) {
        const m = B.getMine().find(x => x.id === lastShownId);
        const s = (m && snap.sessions.find(x => x.id === m.sessionId)) || session();
        if (s) B.downloadIcs(s, m ? gameName(m.gameId) : "");
      } else if (t.hasAttribute("data-roster")) {
        $("#rosterDetails").open = true;
        $("#roster").scrollIntoView({ behavior: B.reducedMotion() ? "auto" : "smooth", block: "start" });
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bind();
    const last = B.store.get(B.NAME_KEY, "");
    if (last) $("#name").value = last;
    B.onState(data => {
      snap = data;
      render(false);
      if (location.hash === "#mine" && !$("#mine").hidden && !render.scrolled) {
        render.scrolled = true;
        $("#mine").scrollIntoView({ block: "start" });
      }
    });
    B.boot({ poll: 20000 }).catch(() => {
      if (!snap) $("#sessions").innerHTML = `<div class="notice">暂时连不上服务器，请检查网络后刷新页面。</div>`;
    });
  });
})();
