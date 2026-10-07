/* 管理后台 */
(function () {
  "use strict";
  const B = window.BGC;
  const { $, $$, esc } = B;
  const KEY = "bgc.adminKey";
  const GROUPS = ["身份类", "桌游", "特色"];
  const ICON_KEYS = ["house", "gem", "flag", "shuriken", "bubble", "moon", "shield", "dice", "crown", "sub", "mask", "mug", "dice2", "letter", "tile", "spade"];
  const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  let key = "";
  let data = null;
  let tab = "list";
  let sid = null;
  let q = "";
  let filter = "all";
  try {
    key = sessionStorage.getItem(KEY) || "";
  } catch {}

  const call = (path, opts = {}) => B.api(path, { ...opts, admin: key });
  const game = id => data?.games.find(g => g.id === id);
  const gname = id => game(id)?.name || (id ? `（已删除：${id}）` : "");
  const view = () => data?.allSessions.find(s => s.id === sid) || null;
  const fmtTime = iso => {
    const d = new Date(Date.parse(iso) + (data?.settings.tzOffsetMinutes ?? 480) * 60000);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(5, 16).replace("T", " ");
  };
  function apply(res) {
    if (res && res.state) {
      data = res.state;
      render();
    }
  }
  async function guard(fn, okMsg) {
    try {
      const res = await fn();
      apply(res);
      if (okMsg) B.toast(okMsg, "ok");
      return res;
    } catch (error) {
      if (error.status === 401) return logout("登录已失效，请重新输入密钥");
      B.toast(error.message, "error");
      return null;
    }
  }

  // ---------- 登录 ----------
  function showLogin(msg) {
    $("#login").hidden = false;
    $("#app").hidden = true;
    $("#logout").hidden = true;
    $("#loginErr").textContent = msg || "";
    setTimeout(() => $("#key").focus(), 50);
  }
  function logout(msg) {
    key = "";
    try {
      sessionStorage.removeItem(KEY);
    } catch {}
    showLogin(msg);
  }
  async function load() {
    data = await call("/api/admin/state");
    const ids = data.allSessions.map(s => s.id);
    if (!sid || !ids.includes(sid)) sid = data.sessions.find(s => s.status === "open" || s.status === "live")?.id || data.sessions[0]?.id || ids[0] || null;
    $("#login").hidden = true;
    $("#app").hidden = false;
    $("#logout").hidden = false;
    render();
  }

  // ---------- 通用 ----------
  function sessionLabel(s) {
    const st = { open: "报名中", live: "进行中", ended: "已结束", cancelled: "停办" }[s.status];
    return `${B.fmtDate(s.date)} ${s.time} · ${st} · ${s.signups.length} 人${s.extra ? " · 加场" : ""}`;
  }
  function renderPicker() {
    const upcoming = new Set(data.sessions.map(s => s.id));
    const up = data.allSessions.filter(s => upcoming.has(s.id)).sort((a, b) => a.date.localeCompare(b.date));
    const past = data.allSessions.filter(s => !upcoming.has(s.id) && (s.signups.length || s.extra || s.status === "cancelled"));
    $("#sessionPick").innerHTML = `<optgroup label="即将进行">${up.map(s => `<option value="${esc(s.id)}">${esc(sessionLabel(s))}</option>`).join("")}</optgroup>${past.length ? `<optgroup label="历史场次">${past.map(s => `<option value="${esc(s.id)}">${esc(sessionLabel(s))}</option>`).join("")}</optgroup>` : ""}`;
    if (![...$("#sessionPick").options].some(o => o.value === sid)) sid = up[0]?.id || past[0]?.id || null;
    $("#sessionPick").value = sid || "";
    $("#sessionPickRow").hidden = !["list", "tables"].includes(tab);
  }
  function placements(v) {
    const map = new Map();
    for (const [gid, g] of Object.entries(v.alloc.games)) {
      for (const t of g.tables) for (const p of t.players) map.set(p.id, { gid, table: t.no, short: t.short, via: p.via });
      g.waitlist.forEach((p, i) => map.set(p.id, { gid, wait: i + 1 }));
    }
    for (const p of v.alloc.orphans || []) map.set(p.id, { orphan: true });
    return map;
  }
  function placeText(pl) {
    if (!pl) return "";
    if (pl.orphan) return `<span class="tag tag-wait">游戏已下架</span>`;
    if (pl.wait) return `${esc(gname(pl.gid))} <span class="tag tag-wait">候补 ${pl.wait}</span>`;
    return `${esc(gname(pl.gid))} · 第${pl.table}桌${pl.short ? `<span class="tag tag-wait">差${pl.short}</span>` : ""}${pl.via === "alt" ? ` <span class="tag tag-alt">二志愿</span>` : ""}`;
  }
  function download(name, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  // ---------- 名单 ----------
  function renderList() {
    const v = view();
    const box = $("#tab-list");
    if (!v) {
      box.innerHTML = `<div class="empty">还没有场次</div>`;
      return;
    }
    const pl = placements(v);
    const all = [...v.signups].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const ql = q.toLowerCase();
    const rows = all.filter(s => {
      if (ql && !`${s.name} ${s.note} ${gname(s.gameId)}`.toLowerCase().includes(ql)) return false;
      if (filter === "in") return s.checkedIn;
      if (filter === "notin") return !s.checkedIn;
      if (filter === "wait") return pl.get(s.id)?.wait;
      if (filter === "new") return s.level === 0;
      if (filter === "teach") return s.teach || s.level === 2;
      return true;
    });
    const k = {
      total: all.length,
      inn: all.filter(s => s.checkedIn).length,
      newbie: all.filter(s => s.level === 0).length,
      teach: all.filter(s => s.teach || s.level === 2).length,
      wait: all.filter(s => pl.get(s.id)?.wait).length,
      tables: v.alloc.totals.tablesReady,
    };
    if (!$("#listToolbar", box)) {
      box.innerHTML = `<div id="listKpis"></div>
      <div class="toolbar" id="listToolbar">
        <input class="input" id="q" type="search" placeholder="搜索称呼、游戏或备注" value="${esc(q)}">
        <select class="select" id="filter">
          ${[["all", "全部"], ["notin", "未签到"], ["in", "已签到"], ["wait", "候补"], ["new", "新手"], ["teach", "能教/愿教"]].map(([v2, l]) => `<option value="${v2}" ${filter === v2 ? "selected" : ""}>${l}</option>`).join("")}
        </select>
        <button class="btn btn-sm btn-primary" type="button" data-act="add">＋ 添加报名</button>
        <button class="btn btn-sm" type="button" data-act="csv">导出本场 CSV</button>
        <button class="btn btn-sm" type="button" data-act="csv-all">导出全部 CSV</button>
      </div>
      <div id="listResults"></div>`;
    }
    $("#listKpis", box).innerHTML = `
      <div class="kpis"><span class="kpi"><b>${k.total}</b>报名</span><span class="kpi"><b>${k.inn}</b>已签到</span><span class="kpi"><b>${k.tables}</b>已成桌</span><span class="kpi"><b>${k.newbie}</b>新手</span><span class="kpi"><b>${k.teach}</b>能教/愿教</span><span class="kpi"><b>${k.wait}</b>候补</span></div>`;
    $("#listResults", box).innerHTML = `${rows.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>称呼</th><th>第一志愿</th><th>第二志愿</th><th>熟悉</th><th>分配结果</th><th>签到</th><th>备注</th><th>报名时间</th><th>操作</th></tr></thead><tbody>
        ${rows
          .map(s => {
            const lv = s.level === null ? "—" : B.LEVELS[s.level];
            const lvTag = s.level === 0 ? "tag-new" : s.level === 2 ? "tag-pro" : "";
            return `<tr>
              <td class="num">${all.indexOf(s) + 1}</td>
              <td><b>${esc(s.name)}</b>${s.by !== "self" ? ` <span class="tag">${s.by === "admin" ? "代报" : "导入"}</span>` : ""}</td>
              <td>${esc(gname(s.gameId))}</td>
              <td>${esc(gname(s.altGameId)) || "—"}</td>
              <td><span class="tag ${lvTag}">${esc(lv)}</span>${s.teach ? ` <span class="tag tag-pro">愿教</span>` : ""}</td>
              <td>${placeText(pl.get(s.id))}</td>
              <td><label class="check"><input type="checkbox" data-checkin="${esc(s.id)}" ${s.checkedIn ? "checked" : ""} aria-label="${esc(s.name)} 签到"></label></td>
              <td class="note">${esc(s.note)}</td>
              <td class="time">${esc(fmtTime(s.createdAt))}</td>
              <td class="acts"><button class="btn btn-xs" type="button" data-edit="${esc(s.id)}">编辑</button> <button class="btn btn-xs btn-danger" type="button" data-del="${esc(s.id)}">删除</button></td>
            </tr>`;
          })
          .join("")}
      </tbody></table></div>` : `<div class="empty">${all.length ? "没有符合筛选条件的报名" : "这一场还没有人报名"}</div>`}`;
  }

  function signupForm(s, v) {
    const opts = (sel, allowEmpty) => `${allowEmpty ? `<option value="">无</option>` : ""}${(v.allGameIds || v.gameIds).map(id => `<option value="${esc(id)}" ${sel === id ? "selected" : ""}>${esc(gname(id))}</option>`).join("")}`;
    return `<h2 id="modalTitle" class="modal-title">${s ? "编辑报名" : "添加报名"} · ${esc(B.fmtDate(v.date))}</h2>
    <form id="suForm" class="form-grid">
      <div class="field span-2"><label class="label" for="f-name">称呼</label><input class="input" id="f-name" name="name" maxlength="20" required value="${esc(s?.name || "")}"></div>
      <div class="field"><label class="label" for="f-game">第一志愿</label><select class="select" id="f-game" name="gameId">${opts(s?.gameId, false)}</select></div>
      <div class="field"><label class="label" for="f-alt">第二志愿</label><select class="select" id="f-alt" name="altGameId">${opts(s?.altGameId, true)}</select></div>
      <div class="field"><label class="label" for="f-level">熟悉程度</label><select class="select" id="f-level" name="level"><option value="">未填</option>${B.LEVELS.map((l, i) => `<option value="${i}" ${s?.level === i ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="field"><span class="label">其他</span><label class="check"><input type="checkbox" name="teach" ${s?.teach ? "checked" : ""}>愿意教学</label><label class="check"><input type="checkbox" name="checkedIn" ${s?.checkedIn ? "checked" : ""}>已签到</label></div>
      <div class="field span-all"><label class="label" for="f-note">备注</label><textarea class="textarea" id="f-note" name="note" maxlength="120">${esc(s?.note || "")}</textarea></div>
      <div class="modal-actions span-all"><button class="btn btn-ghost" type="button" data-close>取消</button><button class="btn btn-primary" type="submit">保存</button></div>
    </form>`;
  }
  function openSignup(id) {
    const v = view();
    const s = id ? v.signups.find(x => x.id === id) : null;
    const m = B.openModal(signupForm(s, v), { wide: true });
    $("#suForm", m).addEventListener("submit", async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const body = { name: f.get("name"), gameId: f.get("gameId"), altGameId: f.get("altGameId"), level: f.get("level") === "" ? null : Number(f.get("level")), teach: f.get("teach") === "on", checkedIn: f.get("checkedIn") === "on", note: f.get("note") };
      const res = await guard(() => (s ? call(`/api/signups/${encodeURIComponent(s.id)}`, { method: "PATCH", body }) : call("/api/signups", { method: "POST", body: { ...body, sessionId: v.id } })), s ? "已保存" : "已添加");
      if (res) B.closeModal();
    });
  }

  // ---------- 分桌 / 签到 ----------
  function renderTables() {
    const v = view();
    const box = $("#tab-tables");
    if (!v) {
      box.innerHTML = "";
      return;
    }
    const byId = new Map(v.signups.map(s => [s.id, s]));
    const blocks = (v.allGameIds || v.gameIds)
      .map(id => ({ g: game(id), a: v.alloc.games[id] }))
      .filter(x => x.g && x.a && (x.a.count || x.a.waitlist.length))
      .sort((x, y) => y.a.count - x.a.count)
      .map(({ g, a }) => {
        const player = p => {
          const s = byId.get(p.id);
          const marks = `${p.teach || p.level === 2 ? " 🎓" : ""}${p.level === 0 ? " 🌱" : ""}${p.via === "alt" ? " ↪" : ""}`;
          return `<div class="aplayer ${s?.checkedIn ? "in" : ""}"><span>${esc(p.name)}${marks}</span><label class="check"><input type="checkbox" data-checkin="${esc(p.id)}" ${s?.checkedIn ? "checked" : ""} aria-label="${esc(p.name)} 签到">签到</label></div>`;
        };
        return `<div class="alloc-game" style="--c:${B.color(g)}"><h3><span class="gi">${B.icon(g, 20)}</span>${esc(g.name)}</h3>
          <p class="sub">每桌 ${a.size} 人 · ${a.copies} 套 · 最少 ${a.min} 人 · 已报 ${a.count}${a.waitlist.length ? ` · 候补 ${a.waitlist.length}` : ""}</p>
          ${a.tables.map(t => `<div class="atable"><div class="atable-h"><b>第 ${t.no} 桌</b><span>${t.players.length} 人${t.short ? ` · 差 ${t.short} 人` : ""}</span></div>${t.players.map(player).join("")}</div>`).join("")}
          ${a.waitlist.length ? `<div class="atable"><div class="atable-h"><b>候补</b></div>${a.waitlist.map(player).join("")}</div>` : ""}</div>`;
      });
    box.innerHTML = `<div class="toolbar no-print"><span class="hint">${v.status === "open" ? "报名中：分桌为实时预估，开局后按第二志愿做最终调整。" : "已截止：以下为最终分桌。"}</span><button class="btn btn-sm" type="button" data-act="print">打印分桌表</button></div>
      ${blocks.length ? `<div class="alloc-grid">${blocks.join("")}</div>` : `<div class="empty">这一场还没有人报名</div>`}`;
  }

  // ---------- 场次 ----------
  function sessionCard(s) {
    const active = data.games.filter(g => g.active || s.gameIds.includes(g.id));
    const offered = new Set(s.gameIds);
    return `<form class="ecard" data-session-form="${esc(s.id)}">
      <div class="ecard-h"><h3>${esc(B.fmtDate(s.date))} ${esc(s.time)} <span class="pill ${s.status === "cancelled" ? "pill-full" : s.status === "open" ? "pill-ok" : "pill-live"}">${esc(B.sessionLabel(s))}</span>${s.extra ? `<span class="tag">加场</span>` : ""}</h3>
        <div>${s.extra && !s.signups.length ? `<button class="btn btn-xs btn-danger" type="button" data-del-session="${esc(s.id)}">删除加场</button>` : ""}</div></div>
      <div class="form-grid">
        <div class="field"><label class="label">标题（可空）</label><input class="input" name="title" maxlength="30" value="${esc(s.title)}" placeholder="如：期中特别场"></div>
        <div class="field"><label class="label">开始</label><input class="input" type="time" name="time" value="${esc(s.time)}"></div>
        <div class="field"><label class="label">结束</label><input class="input" type="time" name="endTime" value="${esc(s.endTime)}"></div>
        <div class="field"><label class="label">地点</label><input class="input" name="location" maxlength="40" value="${esc(s.location)}"></div>
        <div class="field span-2"><label class="label">备注（公开显示）</label><input class="input" name="note" maxlength="200" value="${esc(s.note)}" placeholder="如：本周改到 R210 / 停办原因"></div>
        <div class="field"><span class="label">状态</span><label class="check"><input type="checkbox" name="cancelled" ${s.status === "cancelled" ? "checked" : ""}>本场停办</label></div>
      </div>
      <details class="section-block"><summary class="label">本场开放的游戏、套数与每桌人数（不改则用桌游默认设置）</summary>
        <div class="game-cfg"><div class="game-cfg-row head"><span>游戏</span><span>套数</span><span>每桌人数</span></div>
        ${active.map(g => `<div class="game-cfg-row"><label class="check"><input type="checkbox" name="g" value="${esc(g.id)}" ${offered.has(g.id) ? "checked" : ""}>${esc(g.name)}${g.active ? "" : "（已停用）"}</label><input class="input" type="number" min="1" max="20" name="copies_${esc(g.id)}" value="${s.copies[g.id] ?? ""}" placeholder="${g.copies}"><input class="input" type="number" min="1" max="40" name="size_${esc(g.id)}" value="${s.tableSizes[g.id] ?? ""}" placeholder="${g.tableSize || g.max}"></div>`).join("")}
        </div></details>
      <div class="modal-actions"><button class="btn btn-sm btn-primary" type="submit">保存本场设置</button></div>
    </form>`;
  }
  function renderSessions() {
    const box = $("#tab-sessions");
    const up = data.allSessions.filter(s => data.sessions.some(x => x.id === s.id)).sort((a, b) => a.date.localeCompare(b.date));
    box.innerHTML = `<p class="hint">系统每周自动生成「${WEEK[data.settings.weekday]} ${esc(data.settings.time)} · ${esc(data.settings.location)}」的场次，并开放未来 ${data.settings.bookAheadWeeks} 周的预约。某一周要停办、换教室或改时间，在下面修改即可。</p>
      <div class="cards-list section-block">${up.map(sessionCard).join("")}</div>
      <form class="ecard section-block" id="extraForm"><div class="ecard-h"><h3>＋ 加开一场</h3></div>
        <div class="form-grid">
          <div class="field"><label class="label">日期</label><input class="input" type="date" name="date" required></div>
          <div class="field"><label class="label">开始</label><input class="input" type="time" name="time" value="${esc(data.settings.time)}" required></div>
          <div class="field"><label class="label">结束</label><input class="input" type="time" name="endTime" value="${esc(data.settings.endTime)}" required></div>
          <div class="field"><label class="label">地点</label><input class="input" name="location" value="${esc(data.settings.location)}" required></div>
          <div class="field span-2"><label class="label">标题</label><input class="input" name="title" maxlength="30" placeholder="如：期末解压特别场"></div>
        </div>
        <div class="modal-actions"><button class="btn btn-sm btn-primary" type="submit">创建</button></div>
      </form>`;
  }
  async function saveSession(form) {
    const id = form.dataset.sessionForm;
    const f = new FormData(form);
    const checked = f.getAll("g");
    if (!checked.length) return B.toast("至少要开放一款游戏", "error");
    const activeIds = data.games.filter(g => g.active).map(g => g.id);
    const same = checked.length === activeIds.length && activeIds.every(x => checked.includes(x));
    const copies = {};
    const tableSizes = {};
    for (const g of data.games) {
      const c = f.get(`copies_${g.id}`);
      const t = f.get(`size_${g.id}`);
      if (c) copies[g.id] = Number(c);
      if (t) tableSizes[g.id] = Number(t);
    }
    const st = data.settings;
    const own = (val, def) => (String(val || "").trim() === def ? "" : val);
    const body = { title: f.get("title"), time: own(f.get("time"), st.time), endTime: own(f.get("endTime"), st.endTime), location: own(f.get("location"), st.location), note: f.get("note"), status: f.get("cancelled") ? "cancelled" : "", gameIds: same ? [] : checked, copies, tableSizes };
    await guard(() => call(`/api/admin/sessions/${encodeURIComponent(id)}`, { method: "PUT", body }), "场次已保存");
  }

  // ---------- 桌游 ----------
  function renderGames() {
    const box = $("#tab-games");
    const list = [...data.games].sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
    box.innerHTML = `<div class="toolbar"><button class="btn btn-sm btn-primary" type="button" data-act="new-game">＋ 新增桌游</button><span class="hint">停用的游戏不会出现在游戏库和报名页，历史报名不受影响。</span></div>
      <div class="cards-list">${list
        .map(
          g => `<div class="grow ${g.active ? "" : "off"}" style="--c:${B.color(g)}"><span class="gi">${B.icon(g, 22)}</span>
        <div><b>${esc(g.name)}</b> <span class="tag">${esc(g.group)}</span> <span class="tag">${esc(g.category)}</span>${g.active ? "" : ` <span class="tag tag-wait">已停用</span>`}
        <small>${g.min}–${g.max} 人 · ${g.minutes} 分钟 · ${g.copies} 套 · 每桌 ${g.tableSize || g.max} 人 · ${g.video ? `视频 ${esc(g.video.bvid)}` : "无教学视频"}</small></div>
        <div class="acts"><button class="btn btn-xs" type="button" data-edit-game="${esc(g.id)}">编辑</button> <button class="btn btn-xs" type="button" data-toggle-game="${esc(g.id)}">${g.active ? "停用" : "启用"}</button> <button class="btn btn-xs btn-danger" type="button" data-del-game="${esc(g.id)}">删除</button></div></div>`,
        )
        .join("")}</div>`;
  }
  function gameForm(g) {
    const v = (x, d = "") => esc(x ?? d);
    return `<h2 id="modalTitle" class="modal-title">${g ? `编辑：${esc(g.name)}` : "新增桌游"}</h2>
    <form id="gForm" class="form-grid">
      <div class="field"><label class="label">名称 *</label><input class="input" name="name" maxlength="32" required value="${v(g?.name)}"></div>
      <div class="field"><label class="label">英文/原名</label><input class="input" name="en" maxlength="60" value="${v(g?.en)}"></div>
      <div class="field"><label class="label">分类</label><select class="select" name="group">${GROUPS.map(x => `<option ${g?.group === x ? "selected" : ""}>${x}</option>`).join("")}</select></div>
      <div class="field"><label class="label">类型标签</label><input class="input" name="category" maxlength="16" value="${v(g?.category)}" placeholder="如：阵营推理"></div>
      <div class="field"><label class="label">最少人数</label><input class="input" type="number" name="min" min="1" max="40" value="${v(g?.min, 2)}"></div>
      <div class="field"><label class="label">最多人数</label><input class="input" type="number" name="max" min="1" max="40" value="${v(g?.max, 4)}"></div>
      <div class="field"><label class="label">时长（分钟）</label><input class="input" type="number" name="minutes" min="5" max="600" value="${v(g?.minutes, 30)}"></div>
      <div class="field"><label class="label">难度</label><select class="select" name="difficulty">${[1, 2, 3].map(d => `<option value="${d}" ${g?.difficulty === d ? "selected" : ""}>${B.DIFF[d]}</option>`).join("")}</select></div>
      <div class="field"><label class="label">拥有套数</label><input class="input" type="number" name="copies" min="1" max="20" value="${v(g?.copies, 1)}"></div>
      <div class="field"><label class="label">每桌人数上限（空=最多人数）</label><input class="input" type="number" name="tableSize" min="1" max="40" value="${v(g?.tableSize)}"></div>
      <div class="field span-all"><span class="label">图标</span><div class="icon-pick">${ICON_KEYS.map(k => `<label><input type="radio" name="icon" value="${k}" ${(g?.icon || "dice") === k ? "checked" : ""}><span>${B.icon({ icon: k }, 22)}</span></label>`).join("")}</div></div>
      <div class="field span-all"><label class="label">一句话介绍</label><input class="input" name="intro" maxlength="200" value="${v(g?.intro)}"></div>
      <div class="field span-all"><label class="label">规则速览（每行一条）</label><textarea class="textarea" name="rules" rows="6" maxlength="3000">${v(g?.rules)}</textarea></div>
      <div class="field span-all"><label class="label">醒目提示（可空）</label><input class="input" name="notice" maxlength="120" value="${v(g?.notice)}" placeholder="如：需提前在群里约"></div>
      <div class="field span-2"><label class="label">教学视频（B 站链接或 BV 号）</label><input class="input" name="video" value="${v(g?.video?.bvid)}" placeholder="https://www.bilibili.com/video/BV..."></div>
      <div class="field span-2"><label class="label">备选视频</label><input class="input" name="videoBackup" value="${v(g?.videoBackup?.bvid)}"></div>
      <div class="field"><span class="label">状态</span><label class="check"><input type="checkbox" name="active" ${g?.active === false ? "" : "checked"}>开放</label></div>
      <div class="modal-actions span-all"><button class="btn btn-ghost" type="button" data-close>取消</button><button class="btn btn-primary" type="submit">保存</button></div>
    </form>`;
  }
  function openGame(id) {
    const g = id ? game(id) : null;
    const m = B.openModal(gameForm(g), { wide: true });
    $("#gForm", m).addEventListener("submit", async e => {
      e.preventDefault();
      const f = new FormData(e.target);
      const body = {};
      for (const k of ["name", "en", "group", "category", "intro", "rules", "notice", "icon", "video", "videoBackup"]) body[k] = f.get(k) ?? "";
      for (const k of ["min", "max", "minutes", "difficulty", "copies"]) body[k] = Number(f.get(k));
      body.tableSize = f.get("tableSize") ? Number(f.get("tableSize")) : null;
      body.active = f.get("active") === "on";
      if (body.max < body.min) return B.toast("最多人数不能小于最少人数", "error");
      const res = await guard(() => (g ? call(`/api/admin/games/${encodeURIComponent(g.id)}`, { method: "PUT", body }) : call("/api/admin/games", { method: "POST", body })), "桌游已保存");
      if (res) B.closeModal();
    });
  }

  // ---------- 数据与设置 ----------
  function renderData() {
    const s = data.settings;
    const box = $("#tab-data");
    box.innerHTML = `
      <div class="${data.storage === "postgres" ? "ok-box" : "warn"}">${data.storage === "postgres" ? "✓ 数据保存在 Postgres 数据库，重启、重新部署都不会丢失。每次修改都会自动留存一个历史版本。" : "⚠ 当前使用服务器本地文件存储。Render 免费实例休眠、重启或重新部署时数据可能丢失。请尽快在 Render 环境变量中配置 DATABASE_URL，并定期点下方“导出备份”。"}</div>
      ${data.storeError ? `<div class="warn">数据存储出错：${esc(data.storeError)}（当前为只读模式）</div>` : ""}
      <section class="section-block"><h2>基础设置</h2>
        <form class="ecard" id="settingsForm"><div class="form-grid">
          <div class="field"><label class="label">社团名称</label><input class="input" name="clubName" maxlength="30" value="${esc(s.clubName)}"></div>
          <div class="field"><label class="label">每周活动日</label><select class="select" name="weekday">${WEEK.map((w, i) => `<option value="${i}" ${s.weekday === i ? "selected" : ""}>${w}</option>`).join("")}</select></div>
          <div class="field"><label class="label">开始时间</label><input class="input" type="time" name="time" value="${esc(s.time)}"></div>
          <div class="field"><label class="label">结束时间</label><input class="input" type="time" name="endTime" value="${esc(s.endTime)}"></div>
          <div class="field"><label class="label">默认地点</label><input class="input" name="location" maxlength="40" value="${esc(s.location)}"></div>
          <div class="field"><label class="label">开放预约周数</label><input class="input" type="number" name="bookAheadWeeks" min="1" max="8" value="${s.bookAheadWeeks}"></div>
          <div class="field span-all"><label class="label">首页公告（留空则不显示）</label><input class="input" name="announcement" maxlength="300" value="${esc(s.announcement)}" placeholder="如：本周新到《拉斯维加斯》，欢迎来试玩！"></div>
        </div><div class="modal-actions"><button class="btn btn-sm btn-primary" type="submit">保存设置</button></div></form>
      </section>
      <section class="section-block"><h2>备份与导入</h2>
        <div class="ecard">
          <div class="toolbar"><button class="btn btn-sm" type="button" data-act="export-json">导出完整备份（JSON）</button><button class="btn btn-sm" type="button" data-act="csv-all">导出全部报名（CSV / Excel）</button>
          <label class="btn btn-sm">导入备份…<input type="file" id="importFile" accept="application/json,.json" hidden></label></div>
          <p class="hint">支持导入本系统导出的备份，也支持旧版「开桌」网站导出的备份（会合并进现有数据，同一场次重名的报名会跳过）。</p>
          <h3 class="label section-block">自动历史版本</h3><div class="backup-list" id="backupList"><p class="hint">加载中…</p></div>
        </div>
      </section>`;
    loadBackups();
  }
  async function loadBackups() {
    try {
      const res = await call("/api/admin/backups");
      const el = $("#backupList");
      if (!el) return;
      el.innerHTML = res.backups.length
        ? res.backups.map(b => `<div class="backup-row"><span><span class="mono">v${b.revision}</span> · ${esc(fmtTime(b.updatedAt))} · ${b.games} 款游戏 · ${b.signups} 条报名</span>${b.revision === data.revision ? `<span class="tag">当前</span>` : `<button class="btn btn-xs" type="button" data-restore="${b.revision}">恢复到此版本</button>`}</div>`).join("")
        : `<p class="hint">暂无</p>`;
    } catch (error) {
      const el = $("#backupList");
      if (el) el.innerHTML = `<p class="err">${esc(error.message)}</p>`;
    }
  }

  // ---------- 渲染 & 事件 ----------
  function render() {
    if (!data) return;
    $("#storageWarn").hidden = data.storage === "postgres";
    $("#storageWarn").innerHTML = data.storage === "postgres" ? "" : `⚠ 当前未连接数据库，报名数据可能在服务器重启后丢失。详见「数据与设置」。`;
    $$(".tabs [data-tab]").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    $$(".tab-panel").forEach(p => (p.hidden = p.id !== `tab-${tab}`));
    renderPicker();
    const focusId = document.activeElement?.id;
    ({ list: renderList, tables: renderTables, sessions: renderSessions, games: renderGames, data: renderData })[tab]();
    if (focusId === "q" && $("#q")) {
      const el = $("#q");
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }

  function bind() {
    $("#loginForm").addEventListener("submit", async e => {
      e.preventDefault();
      const k = $("#key").value.trim();
      if (!k) return;
      try {
        await B.api("/api/admin/verify", { method: "POST", admin: k });
        key = k;
        try {
          sessionStorage.setItem(KEY, k);
        } catch {}
        $("#key").value = "";
        await load();
      } catch (error) {
        $("#loginErr").textContent = error.message;
      }
    });
    $("#logout").addEventListener("click", () => logout());
    $(".tabs").addEventListener("click", e => {
      const b = e.target.closest("[data-tab]");
      if (!b) return;
      tab = b.dataset.tab;
      render();
    });
    $("#sessionPick").addEventListener("change", e => {
      sid = e.target.value;
      render();
    });
    $("#refreshBtn").addEventListener("click", () => guard(load, "已刷新"));
    const main = $("#app");
    main.addEventListener("compositionend", e => {
      if (e.target.id === "q") {
        q = e.target.value;
        render();
      }
    });
    main.addEventListener("input", e => {
      if (e.isComposing) return;
      if (e.target.id === "q") {
        q = e.target.value;
        clearTimeout(main._t);
        main._t = setTimeout(render, 150);
      }
    });
    main.addEventListener("change", async e => {
      const t = e.target;
      if (t.id === "filter") {
        filter = t.value;
        render();
      } else if (t.dataset.checkin) {
        await guard(() => call(`/api/signups/${encodeURIComponent(t.dataset.checkin)}`, { method: "PATCH", body: { checkedIn: t.checked } }));
      } else if (t.id === "importFile" && t.files[0]) {
        const file = t.files[0];
        t.value = "";
        let parsed;
        try {
          parsed = JSON.parse(await file.text());
        } catch {
          return B.toast("文件不是有效的 JSON", "error");
        }
        const legacy = Array.isArray((parsed.state || parsed).events);
        const ok = await B.confirmDialog({ title: legacy ? "导入旧版网站备份？" : "用备份覆盖当前数据？", text: legacy ? "会把旧版的游戏和报名合并进当前数据，不会删除现有内容。" : "当前数据会被备份内容替换（导入前的版本仍可在历史版本里恢复）。", ok: "导入", danger: !legacy });
        if (!ok) return;
        const res = await guard(() => call("/api/admin/import", { method: "POST", body: { data: parsed } }));
        if (res) B.toast(legacy ? `导入完成，合并了 ${res.result.imported} 条报名` : "导入完成", "ok");
      }
    });
    main.addEventListener("submit", async e => {
      const form = e.target;
      if (form.dataset.sessionForm) {
        e.preventDefault();
        await saveSession(form);
      } else if (form.id === "extraForm") {
        e.preventDefault();
        const f = new FormData(form);
        const date = f.get("date");
        const exists = data.allSessions.find(s => s.id === date);
        if (exists && !exists.extra) return B.toast("这一天已经有常规场次了，直接在上面修改即可", "error");
        await guard(() => call(`/api/admin/sessions/${encodeURIComponent(date)}`, { method: "PUT", body: { extra: true, time: f.get("time"), endTime: f.get("endTime"), location: f.get("location"), title: f.get("title") } }), "已加开场次");
      } else if (form.id === "settingsForm") {
        e.preventDefault();
        const f = new FormData(form);
        const body = Object.fromEntries(f.entries());
        body.weekday = Number(body.weekday);
        body.bookAheadWeeks = Number(body.bookAheadWeeks);
        await guard(() => call("/api/admin/settings", { method: "PUT", body }), "设置已保存");
      }
    });
    main.addEventListener("click", async e => {
      const t = e.target.closest("button");
      if (!t) return;
      const d = t.dataset;
      if (d.act === "add") openSignup(null);
      else if (d.act === "print") window.print();
      else if (d.act === "csv" || d.act === "csv-all") {
        const which = d.act === "csv" ? sid : "all";
        try {
          const text = await call(`/api/admin/export.csv?session=${encodeURIComponent(which)}`);
          download(`报名-${which}.csv`, text.charCodeAt(0) === 0xfeff ? text : `﻿${text}`, "text/csv;charset=utf-8");
        } catch (error) {
          B.toast(error.message, "error");
        }
      } else if (d.act === "export-json") {
        try {
          const json = await call("/api/admin/export");
          download(`kaizhuo-backup-v${json.revision}.json`, JSON.stringify(json, null, 2), "application/json");
        } catch (error) {
          B.toast(error.message, "error");
        }
      } else if (d.act === "new-game") openGame(null);
      else if (d.edit) openSignup(d.edit);
      else if (d.del) {
        const s = view().signups.find(x => x.id === d.del);
        if (await B.confirmDialog({ title: "删除这条报名？", text: `${s?.name || ""} · ${gname(s?.gameId)}`, ok: "删除", danger: true })) await guard(() => call(`/api/signups/${encodeURIComponent(d.del)}`, { method: "DELETE" }), "已删除");
      } else if (d.editGame) openGame(d.editGame);
      else if (d.toggleGame) {
        const g = game(d.toggleGame);
        await guard(() => call(`/api/admin/games/${encodeURIComponent(g.id)}`, { method: "PUT", body: { active: !g.active } }), g.active ? "已停用" : "已启用");
      } else if (d.delGame) {
        const g = game(d.delGame);
        if (await B.confirmDialog({ title: `删除「${g.name}」？`, text: "删除后无法恢复（可从历史版本回滚）。只有从未被报名过的游戏才能删除，否则请用“停用”。", ok: "删除", danger: true })) await guard(() => call(`/api/admin/games/${encodeURIComponent(g.id)}`, { method: "DELETE" }), "已删除");
      } else if (d.delSession) {
        if (await B.confirmDialog({ title: "删除这个加场？", text: B.fmtDate(d.delSession), ok: "删除", danger: true })) await guard(() => call(`/api/admin/sessions/${encodeURIComponent(d.delSession)}`, { method: "DELETE" }), "已删除");
      } else if (d.restore) {
        if (await B.confirmDialog({ title: `恢复到 v${d.restore}？`, text: "当前数据会被这个历史版本替换（替换前的版本也会保留在历史里，可以再恢复回来）。", ok: "恢复", danger: true })) {
          const res = await guard(() => call(`/api/admin/backups/${d.restore}/restore`, { method: "POST" }), "已恢复");
          if (res) loadBackups();
        }
      }
    });
    // 弹窗里的按钮不在 #app 内，单独代理“签到”等不需要；弹窗表单自己绑定
  }

  document.addEventListener("DOMContentLoaded", async () => {
    bind();
    if (B.inWeChat()) {
      const w = document.createElement("div");
      w.className = "warn";
      w.textContent = "提示：微信内置浏览器无法导出文件和打印。请点右上角「…」→ 在浏览器打开，再使用导出 / 打印功能。";
      $("#main").prepend(w);
    }
    if (!key) return showLogin();
    try {
      await load();
    } catch (error) {
      if (error.status === 401 || error.status === 403) logout(error.message);
      else showLogin(error.message);
    }
    setInterval(() => {
      if (document.visibilityState === "visible" && key && !document.querySelector("#modal") && tab !== "sessions" && tab !== "data") load().catch(() => {});
    }, 30000);
  });
})();
