/* 报名页：选场次 → 按喜欢程度点选游戏（志愿排序）→ 选轮次 → 填信息 → 提交；本机可修改 / 取消；公开名单按轮次 */
(function () {
  "use strict";
  const B = window.BGC;
  const { $, $$, esc } = B;
  const params = new URLSearchParams(location.search);
  let snap = null;
  let sessionId = null;
  let ranked = params.get("game") ? [params.get("game")] : []; // 志愿顺序（游戏 id）
  let chosenRounds = null; // null = 全部
  const wantedSession = params.get("session");
  const wantedEdit = params.get("edit");
  let editing = null;
  let busy = false;
  let lastShownId = "";
  let forFriend = false;
  let pendingCreate = null; // 网络中断时重试复用同一个 id 和凭证
  let rosterRound = 1;
  let teachPicked = new Set(); // 这次新勾的「我能讲规的游戏」（已挂名的显示为已勾、不能取消）

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

  // ---------- 角色字幕 & 特效 ----------
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
    setHTML(
      box,
      snap.sessions
        .map(s => {
          const off = s.status === "cancelled" || s.status === "ended";
          const sub = s.status === "open" ? `已报 ${s.alloc.totals.signups} 人 · ${s.rounds.length} 轮` : B.sessionLabel(s);
          const place = s.location !== snap.settings.location ? ` · ${esc(s.location)}` : "";
          return `<button type="button" class="sess ${off ? "off" : ""}" role="radio" aria-checked="${s.id === sessionId}" data-sid="${esc(s.id)}">
          <span class="sess-tag">${esc(s.title || B.relDay(s.date, snap.settings.tzOffsetMinutes))}${s.extra ? " · 加场" : ""}</span>
          <b>${esc(B.fmtDate(s.date))} ${esc(s.time)}</b>
          <small>${esc(sub)}${place}</small>
        </button>`;
        })
        .join(""),
    );
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
      if (s.customRounds) bits.push(`本场轮次：${s.rounds.map(r => `第${r.index}轮 ${r.start}–${r.end}`).join("、")}`);
      if (s.note) bits.push(`组织者备注：${esc(s.note)}`);
      html = bits.join("<br>");
    }
    el.hidden = !html;
    setHTML(el, html);
    $("#locLabel").textContent = s?.location || snap?.settings.location || "R312";
  }

  // ---------- 志愿排序 ----------
  function allowedIds(s) {
    if (!s) return [];
    return editing && editing.sessionId === s.id ? [...new Set([...s.gameIds, ...(editing.prefs || [])])] : s.gameIds;
  }
  function renderGames(s) {
    const box = $("#gameOptions");
    if (!s) {
      setHTML(box, "");
      return;
    }
    const allow = allowedIds(s);
    ranked = ranked.filter(id => allow.includes(id));
    const games = allow.map(B.gameById).filter(Boolean);
    const groups = [...B.GROUPS, ...new Set(games.map(g => g.group).filter(x => !B.GROUPS.includes(x)))];
    const multi = groups.filter(gr => games.some(g => g.group === gr)).length > 1;
    const active = document.activeElement;
    const focusSel = active && box.contains(active) ? (active.name === "pref" ? `input[value="${CSS.escape(active.value)}"]` : active.dataset.open ? `[data-open="${CSS.escape(active.dataset.open)}"]` : "") : "";
    const changed = setHTML(
      box,
      groups
        .map(gr => {
          const list = games.filter(g => g.group === gr);
          if (!list.length) return "";
          return `${multi ? `<div class="gopt-group">${esc(gr)}</div>` : ""}${list
            .map(g => {
              const info = B.seatInfo(g, s);
              const rank = ranked.indexOf(g.id) + 1;
              return `<label class="gopt" style="--c:${B.color(g)}">
              <input type="checkbox" name="pref" value="${esc(g.id)}" ${rank ? "checked" : ""}>
              <span class="gopt-body">
                <span class="gopt-rank" aria-hidden="true">${rank || ""}</span>
                <span class="gopt-icon">${B.icon(g, 24)}</span>
                <span class="gopt-name">${esc(g.name)}</span>
                <span class="gopt-meta">${g.min}–${g.max}人 · ${g.minutes}分钟 · ${B.DIFF[g.difficulty]}</span>
                ${g.notice ? `<span class="gopt-warn">⚠ ${esc(g.notice)}</span>` : ""}
                <span class="gopt-seat pill pill-${info.tone}" title="${esc(info.text)}">${esc(info.short)}</span>
                ${B.teachersOf(g.id).length ? `<span class="gopt-teach" title="${B.teachersOf(g.id).length} 人挂名会讲这款的规则">🎓 ${B.teachersOf(g.id).length} 人会讲</span>` : ""}
              </span>
              <button type="button" class="gopt-video" data-open="${esc(g.id)}" aria-label="查看${esc(g.name)}的教学视频和规则">${g.video ? "▶ 教学" : "规则"}</button>
            </label>`;
            })
            .join("")}`;
        })
        .join(""),
    );
    if (changed && focusSel) $(focusSel, box)?.focus({ preventScroll: true });
  }
  function renderRanked() {
    const box = $("#ranked");
    if (!ranked.length) {
      setHTML(box, `<p class="ranked-empty">还没选：点下面的游戏卡片，按喜欢程度依次选</p>`);
      return;
    }
    setHTML(
      box,
      `<span class="ranked-label">我的志愿</span>${ranked
        .map((id, i) => `<span class="rk"><b>${i + 1}</b>${esc(gameName(id))}${i ? `<button type="button" class="rk-btn" data-up="${esc(id)}" aria-label="把${esc(gameName(id))}往前移">↑</button>` : ""}<button type="button" class="rk-btn" data-remove="${esc(id)}" aria-label="移除${esc(gameName(id))}">×</button></span>`)
        .join("")}`,
    );
  }
  function syncRankBadges() {
    $$("#gameOptions .gopt").forEach(label => {
      const input = $("input[name=pref]", label);
      const rank = ranked.indexOf(input.value) + 1;
      input.checked = rank > 0;
      $(".gopt-rank", label).textContent = rank || "";
    });
  }

  // ---------- 轮次 ----------
  function renderRounds(s) {
    const box = $("#roundOptions");
    if (!s) return setHTML(box, "");
    const all = s.rounds.map(r => r.index);
    const picked = chosenRounds ? chosenRounds.filter(n => all.includes(n)) : all;
    setHTML(
      box,
      s.rounds
        .map(r => {
          const closed = r.status !== "open";
          return `<label class="round-opt ${closed ? "off" : ""}"><input type="checkbox" name="round" value="${r.index}" ${picked.includes(r.index) ? "checked" : ""} ${closed && !editing ? "disabled" : ""}><span><b>第 ${r.index} 轮</b><small>${esc(r.start)}–${esc(r.end)}</small></span></label>`;
        })
        .join(""),
    );
    $("#stepRounds").hidden = s.rounds.length < 2;
  }
  const currentRounds = () => $$("input[name=round]:checked").map(x => Number(x.value));

  // ---------- 汇总 ----------
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
    if (!ranked.length) {
      setHTML(out, `<b>${esc(B.fmtDate(s.date))} ${esc(s.time)}</b> · ${esc(s.location)}<br>先在上面按喜欢程度点选游戏`);
      return;
    }
    const rounds = s.rounds.length > 1 ? currentRounds() : [1];
    const roundsText = s.rounds.length > 1 ? (rounds.length ? ` · 参加第 ${rounds.join("、")} 轮` : " · 还没选轮次") : "";
    const top = ranked.slice(0, 3).map(gameName).join(" > ");
    setHTML(out, `<b>${esc(B.fmtDate(s.date))} · ${ranked.length} 款志愿${roundsText}</b><br>${esc(top)}${ranked.length > 3 ? " …" : ""}${editing && JSON.stringify(editing.prefs) !== JSON.stringify(ranked) ? " · 改志愿会按修改时间重新排队" : ""}`);
  }
  function setFormEnabled(on) {
    $$("#form fieldset").forEach(f => (f.disabled = !on));
  }
  function updateLevelUI() {
    const lv = $("input[name=level]:checked")?.value;
    $("#teachRow").hidden = lv === undefined || lv === "0";
  }

  // ---------- 我能讲规的游戏（按称呼对应长期讲规名单） ----------
  function renderTeach() {
    if (!snap) return;
    const listed = new Set(B.rosterGamesFor($("#name").value));
    const order = x => Math.max(0, B.GROUPS.indexOf(x.group));
    const games = snap.games.filter(g => g.active || listed.has(g.id)).sort((a, b) => order(a) - order(b));
    setHTML(
      $("#teachOptions"),
      games
        .map(g => {
          const on = listed.has(g.id);
          return `<label class="topt ${on ? "listed" : ""}" style="--c:${B.color(g)}"${on ? ` title="已经挂在讲规名单上；撤下请到游戏库"` : ""}><input type="checkbox" name="teachGame" value="${esc(g.id)}" ${on || teachPicked.has(g.id) ? "checked" : ""} ${on ? "disabled" : ""}><span>${esc(g.name)}${on ? "<small>已挂名</small>" : ""}</span></label>`;
        })
        .join(""),
    );
  }

  // ---------- 我的报名（简版，完整版在 /me） ----------
  function renderMine() {
    const box = $("#mine");
    const rows = [];
    for (const m of B.getMine()) {
      const s = snap.sessions.find(x => x.id === m.sessionId);
      if (!s) continue;
      const pl = B.placementOf(s, m.id);
      const unsure = !pl && (B.degraded || snap.fromCache);
      if (m.pending && !pl && !unsure) {
        rows.push(`<div class="mine-row"><div><b>${esc(m.name || "")} · ${esc(B.fmtDate(s.date))}</b><p>上次提交时网络中断，没有报名成功，请重新提交</p></div><div class="mine-acts"><button class="btn btn-xs" type="button" data-forget="${esc(m.id)}">知道了</button></div></div>`);
        continue;
      }
      if (m.pending && pl) B.updateMine(m.id, { pending: false });
      const canEdit = isOpen(s) && pl;
      rows.push(`<div class="mine-row">
        <div><b>${esc(m.name || "")} · ${esc(B.fmtDate(s.date))} ${esc(s.time)}</b>
        <p>${pl ? esc(B.placementText(pl)) : unsure ? "正在同步报名状态…" : "这条报名已被取消或移除"}${s.status === "cancelled" ? " · 本场停办" : ""}</p></div>
        <div class="mine-acts">${canEdit ? `<button class="btn btn-xs" type="button" data-edit="${esc(m.id)}">修改</button><button class="btn btn-xs btn-danger" type="button" data-cancel="${esc(m.id)}">取消</button>` : ""}${!pl && !unsure ? `<button class="btn btn-xs" type="button" data-forget="${esc(m.id)}">移除记录</button>` : ""}</div>
      </div>`);
    }
    $("#mine").hidden = !rows.length;
    setHTML($("#mineList"), rows.join(""));
  }

  // ---------- 名单（按轮） ----------
  function renderRoster(s) {
    const body = $("#rosterBody");
    if (!s) {
      setHTML(body, "");
      setHTML($("#rosterRounds"), "");
      return;
    }
    const rounds = s.alloc.rounds;
    if (!rounds.some(r => r.index === rosterRound)) rosterRound = 1;
    setHTML(
      $("#rosterRounds"),
      rounds.length > 1 ? rounds.map(r => `<button type="button" role="tab" class="rr-tab" aria-selected="${r.index === rosterRound}" data-rr="${r.index}">第 ${r.index} 轮 <small>${esc(r.start)}–${esc(r.end)}</small></button>`).join("") : "",
    );
    const r = rounds.find(x => x.index === rosterRound) || rounds[0];
    const mine = new Set(B.getMine().map(m => m.id));
    $("#rosterTitle").textContent = `${B.fmtDate(s.date)} 名单与分桌 · ${s.alloc.totals.signups} 人报名`;
    const blocks = Object.entries(r.games)
      .filter(([, a]) => a.count)
      .map(([id, a]) => ({ g: B.gameById(id), a }))
      .filter(x => x.g)
      .sort((x, y) => y.a.count - x.a.count)
      .map(({ g, a }) => {
        const tables = a.tables
          .map(t => {
            const names = t.players.map(p => `<span class="name ${mine.has(p.id) ? "me" : ""}">${p.teach ? "🎓" : p.level === 0 ? "🌱" : ""}${esc(p.name)}${p.rank > 1 ? `<sup>${p.rank}</sup>` : ""}</span>`).join("");
            return `<div class="rtable"><div class="rtable-h"><b>第 ${t.no} 桌</b><span>${t.players.length} 人${t.short ? ` · 还差 ${t.short} 人` : " · 已成桌"}</span></div><div class="names">${names}</div>${B.teachNoteHtml(r, g.id, t)}</div>`;
          })
          .join("");
        return `<div class="roster-game" style="--c:${B.color(g)}"><h3><span class="gi">${B.icon(g, 20)}</span>${esc(g.name)}</h3><div class="roster-tables">${tables}</div></div>`;
      });
    const un = r.unassigned.length ? `<div class="roster-game"><h3>暂未成桌（${r.unassigned.length} 人）</h3><p class="wait-line">${r.unassigned.map(p => `<span class="name ${mine.has(p.id) ? "me" : ""}">${esc(p.name)}</span>`).join(" ")}</p><p class="legend">他们的志愿暂时凑不齐人。更多人报名后会自动重新分配，开局时组织者也会现场协调。</p></div>` : "";
    setHTML(
      body,
      blocks.length || un
        ? `${blocks.join("")}${un}<p class="legend"><span>🎓 挂名会讲这款的规则</span><span>🌱 新手</span><span>右上角小数字 = 分到的是第几志愿</span><span>报名截止前会随报名实时调整，开局后锁定</span></p>`
        : `<p class="roster-empty">这一轮还没有人报名，快来当第一个！</p>`,
    );
  }

  // ---------- 总渲染 ----------
  function render() {
    if (!snap) return;
    pickSession();
    const s = session();
    renderSessions();
    renderNotice(s);
    renderMine();
    renderRoster(s);
    renderGames(s);
    renderRanked();
    renderRounds(s);
    setFormEnabled(isOpen(s));
    updateLevelUI();
    renderTeach();
    renderSummary();
  }

  // ---------- 表单 ----------
  function clearErrors() {
    ["#errGame", "#errName", "#errLevel", "#errRounds", "#errPin"].forEach(id => ($(id).textContent = ""));
    $("#name").removeAttribute("aria-invalid");
  }
  function collect() {
    const s = session();
    const lv = $("input[name=level]:checked");
    const body = {
      sessionId,
      prefs: [...ranked],
      name: $("#name").value.trim(),
      level: lv ? Number(lv.value) : null,
      teachGames: $("#teachRow").hidden ? [] : [...teachPicked],
      note: $("#note").value.trim(),
      website: $("input[name=website]").value,
    };
    if (s && s.rounds.length > 1) body.rounds = currentRounds();
    const pin = $("#pin").value.trim();
    if (pin) body.pin = pin;
    return body;
  }
  function validate(d) {
    clearErrors();
    let first = null;
    if (!d.prefs.length) {
      $("#errGame").textContent = "请至少点选一款想玩的游戏";
      if (!first) first = $("#stepGame");
    }
    if (d.rounds && !d.rounds.length) {
      $("#errRounds").textContent = "请至少选择参加一轮";
      if (!first) first = $("#stepRounds");
    }
    if (!d.name) {
      $("#errName").textContent = "请填写称呼";
      $("#name").setAttribute("aria-invalid", "true");
      if (!first) first = $("#name");
    }
    if (d.level === null) {
      $("#errLevel").textContent = "请选择你的桌游经验，方便安排老手带新人";
      if (!first) first = $("#levelSeg");
    }
    if (d.pin && !/^\d{4}$/.test(d.pin)) {
      $("#errPin").textContent = "找回码需要是 4 位数字（也可以不填）";
      if (!first) first = $("#pin");
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
      const local = { name: d.name, prefs: d.prefs, rounds: d.rounds || [], level: d.level, note: d.note, hasPin: Boolean(d.pin) || Boolean(editing?.hasPin) };
      // 报名时顺手挂的讲规名：凭证就是这条报名的凭证，存到设备上以后可以在游戏库撤下
      const keepTeach = (list, token) => (list || []).forEach(t => B.saveMyTeach({ id: t.id, token, gameId: t.gameId, name: d.name }));
      if (editing) {
        res = await B.api(`/api/signups/${encodeURIComponent(editing.id)}`, { method: "PATCH", token: editing.token, body: d });
        B.updateMine(editing.id, local);
        keepTeach(res.signup.teachers, editing.token);
        teachPicked = new Set();
        const id = editing.id;
        editing = null;
        B.setSnapshot(res.state);
        showSuccess(id, true, res.signup.added);
      } else {
        const sig = JSON.stringify(d);
        if (!pendingCreate || pendingCreate.sig !== sig) pendingCreate = { sig, id: `s${randHex(6)}`, token: randToken() };
        const { id, token } = pendingCreate;
        B.saveMine({ id, token, sessionId: d.sessionId, ...local, pending: true });
        try {
          res = await B.api("/api/signups", { method: "POST", body: { ...d, id, token } });
        } catch (error) {
          if (error.status >= 400 && error.status < 500) {
            B.removeMine(id);
            pendingCreate = null;
          } else if (!error.status) error.message = "网络中断，没能确认是否报名成功。可以直接再点一次提交（不会重复报名）";
          throw error;
        }
        pendingCreate = null;
        B.updateMine(id, { pending: false, id: res.signup.id, sessionId: res.signup.sessionId });
        keepTeach(res.signup.teachers, token);
        teachPicked = new Set();
        if (!forFriend) B.store.set(B.NAME_KEY, d.name);
        B.setSnapshot(res.state);
        showSuccess(res.signup.id, false, res.signup.added);
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

  function showSuccess(id, edited, teachAdded = []) {
    lastShownId = id;
    const teachLine = (teachAdded || []).length ? `<div class="full"><small>已挂到讲规名单</small><b>🎓 ${esc(teachAdded.map(t => gameName(t.gameId)).join("、"))}</b></div>` : "";
    const s = snap.sessions.find(x => B.placementOf(x, id)) || session();
    const pl = s ? B.placementOf(s, id) : null;
    const m = B.getMine().find(x => x.id === id) || {};
    const box = $("#success");
    const lines = pl ? pl.map(p => `<div class="full"><small>${esc(p.label)}</small><b>${esc(B.placementLine(p).replace(/^[^：]+：/, ""))}</b></div>`).join("") : "";
    setHTML(
      box,
      `
      <h2>${edited ? "修改成功" : "报名成功！"}</h2>
      <p>${esc(m.name || "")}，${esc(B.fmtDate(s.date))} ${esc(s.time)} ${esc(s.location)} 见～</p>
      <div class="ticket">
        <div class="ticket-head"><span>上桌凭证</span><small>${esc(s.date)}</small></div>
        <div class="ticket-body">
          <div><small>时间</small><b>${esc(B.fmtDate(s.date))} ${esc(s.time)}</b></div>
          <div><small>地点</small><b>${esc(s.location)}</b></div>
          <div class="full"><small>我的志愿</small><b>${esc((m.prefs || []).map((g, i) => `${i + 1}.${gameName(g)}`).join("  "))}</b></div>
          ${lines}
          ${teachLine}
        </div>
      </div>
      <p class="hint">分桌在开局前会随报名人数自动调整；开局（${esc(s.time)}）后锁定。${m.hasPin ? "已设找回码，换浏览器也能在「我的」页面找回。" : "没设找回码：换浏览器后看不到这条报名，可以点「修改」补一个。"}</p>
      <div class="ticket-actions">
        <button class="btn btn-red" type="button" data-again>再帮朋友报一位</button>
        <a class="btn" href="/me">我的报名</a>
        <button class="btn" type="button" data-ics>加入日历</button>
        <button class="btn" type="button" data-edit="${esc(id)}">修改</button>
      </div>`,
    );
    box.hidden = false;
    $("#form").hidden = true;
    $("#formHead").hidden = true;
    box.focus({ preventScroll: true });
    box.scrollIntoView({ behavior: B.reducedMotion() ? "auto" : "smooth", block: "start" });
    say(edited ? "已改妥。周五，R312 见。" : `报名成功——${(m.prefs || []).length} 款志愿，周五见。`);
    cheer();
    if (window.FX) {
      setTimeout(() => FX.burstAt($(".ticket", box), { count: 90, power: 1.2 }), 350);
      setTimeout(() => FX.burstAt($(".ticket-head", box), { count: 50, power: 0.8, colors: ["255,230,160", "255,140,70", "140,255,210"] }), 750);
    }
    render();
  }

  function resetForm({ keepGames = true } = {}) {
    clearErrors();
    $("#name").value = "";
    $$("input[name=level]").forEach(r => (r.checked = false));
    teachPicked = new Set();
    $("#note").value = "";
    $("#pin").value = "";
    if (!keepGames) ranked = [];
  }

  function startEdit(id) {
    const m = B.getMine().find(x => x.id === id);
    if (!m) return B.toast("这台设备上没有这条报名的记录");
    const s = snap.sessions.find(x => x.id === m.sessionId);
    if (!isOpen(s)) return B.toast("这一场已经不能在线修改了", "error");
    editing = m;
    sessionId = m.sessionId;
    ranked = [...(m.prefs || [])];
    chosenRounds = m.rounds && m.rounds.length ? [...m.rounds] : null;
    const pl = B.placementOf(s, id);
    const player = pl && pl.find(x => x.player)?.player;
    render();
    $("#name").value = m.name || player?.name || "";
    const level = m.level ?? player?.level;
    $$("input[name=level]").forEach(r => (r.checked = String(r.value) === String(level)));
    teachPicked = new Set();
    renderTeach();
    $("#note").value = m.note || "";
    $("#pin").value = "";
    $("#pin").placeholder = m.hasPin ? "已设置；填新的 4 位数字可更换" : "如：0612";
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
    resetForm({ keepGames: false });
    chosenRounds = null;
    const last = B.store.get(B.NAME_KEY, "");
    if (last) $("#name").value = last;
    render();
  }

  async function cancelSignup(id) {
    const m = B.getMine().find(x => x.id === id);
    if (!m) return;
    const ok = await B.confirmDialog({ title: "取消这条报名？", text: `${m.name || ""} · ${(m.prefs || []).map(gameName).slice(0, 3).join(" > ")}。取消后名额会让给其他同学。`, ok: "确认取消", danger: true });
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
        render();
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
      render();
    });
    $("#gameOptions").addEventListener("change", e => {
      if (e.target.name !== "pref") return;
      const id = e.target.value;
      if (e.target.checked && !ranked.includes(id)) ranked.push(id);
      if (!e.target.checked) ranked = ranked.filter(x => x !== id);
      $("#errGame").textContent = "";
      syncRankBadges();
      renderRanked();
      renderSummary();
      if (e.target.checked) {
        say(ranked.length === 1 ? `第一志愿：「${gameName(id)}」。再选几个备选更稳。` : `第 ${ranked.length} 志愿：「${gameName(id)}」。`);
        if (window.FX) FX.burstAt(e.target.closest(".gopt")?.querySelector(".gopt-body"), { count: 22, power: 0.4 });
      }
    });
    $("#gameOptions").addEventListener("click", e => {
      const b = e.target.closest("[data-open]");
      if (!b) return;
      e.preventDefault();
      B.openGame(B.gameById(b.dataset.open), { showSignup: false });
    });
    $("#ranked").addEventListener("click", e => {
      const up = e.target.closest("[data-up]");
      const rm = e.target.closest("[data-remove]");
      if (up) {
        const i = ranked.indexOf(up.dataset.up);
        if (i > 0) [ranked[i - 1], ranked[i]] = [ranked[i], ranked[i - 1]];
      } else if (rm) ranked = ranked.filter(x => x !== rm.dataset.remove);
      else return;
      syncRankBadges();
      renderRanked();
      renderSummary();
    });
    $("#roundOptions").addEventListener("change", () => {
      chosenRounds = currentRounds();
      $("#errRounds").textContent = "";
      renderSummary();
    });
    $("#levelSeg").addEventListener("change", e => {
      $("#errLevel").textContent = "";
      const lv = e.target.value;
      updateLevelUI();
      say(lv === "0" ? "初入此道？放心，自有老手带你。" : lv === "2" ? "高手驾到——会讲哪几款？在下面勾上。" : "老手了，开局不用等。");
    });
    $("#teachOptions").addEventListener("change", e => {
      if (e.target.name !== "teachGame") return;
      if (e.target.checked) teachPicked.add(e.target.value);
      else teachPicked.delete(e.target.value);
      renderTeach(); // 让缓存的 HTML 跟上勾选状态，之后重置表单时才会真正刷新
      if (e.target.checked) say(`会讲「${gameName(e.target.value)}」？传道授业，功德无量。`);
    });
    let nameTimer;
    $("#name").addEventListener("input", () => {
      $("#errName").textContent = "";
      $("#name").removeAttribute("aria-invalid");
      clearTimeout(nameTimer);
      nameTimer = setTimeout(renderTeach, 250);
    });
    $("#pin").addEventListener("input", e => {
      e.target.value = e.target.value.replace(/\D/g, "").slice(0, 4);
      $("#errPin").textContent = "";
    });
    $("#form").addEventListener("submit", submit);
    $("#cancelEdit").addEventListener("click", stopEdit);
    $("#rosterRounds").addEventListener("click", e => {
      const b = e.target.closest("[data-rr]");
      if (!b) return;
      rosterRound = Number(b.dataset.rr);
      renderRoster(session());
    });
    document.addEventListener("click", e => {
      const t = e.target.closest("[data-edit],[data-cancel],[data-forget],[data-again],[data-ics]");
      if (!t) return;
      if (t.dataset.edit) startEdit(t.dataset.edit);
      else if (t.dataset.cancel) cancelSignup(t.dataset.cancel);
      else if (t.dataset.forget) {
        B.removeMine(t.dataset.forget);
        render();
      } else if (t.hasAttribute("data-again")) {
        forFriend = true; // 帮朋友报名：不要把朋友的称呼记成“我的称呼”
        resetForm({ keepGames: true });
        $("#success").hidden = true;
        $("#form").hidden = false;
        render();
        $("#name").focus();
        $("#form").scrollIntoView({ behavior: B.reducedMotion() ? "auto" : "smooth", block: "start" });
        say("再添一位——填上朋友的称呼。");
      } else if (t.hasAttribute("data-ics")) {
        const m = B.getMine().find(x => x.id === lastShownId);
        const s = (m && snap.sessions.find(x => x.id === m.sessionId)) || session();
        if (s) B.downloadIcs(s, m ? gameName((m.prefs || [])[0]) : "");
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bind();
    const last = B.store.get(B.NAME_KEY, "");
    if (last) $("#name").value = last;
    let first = true;
    B.onState(data => {
      snap = data;
      render();
      if (first) {
        first = false;
        if (wantedEdit) startEdit(wantedEdit);
        else if (location.hash === "#mine" && !$("#mine").hidden) $("#mine").scrollIntoView({ block: "start" });
      }
    });
    B.boot({ poll: 20000 }).catch(() => {
      if (!snap) $("#sessions").innerHTML = `<div class="notice">暂时连不上服务器，请检查网络后刷新页面。</div>`;
    });
  });
})();
