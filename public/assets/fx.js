/* 报名页特效：背景火星上升 + 选择/成功时的粒子爆发（尊重“减少动态效果”，页面隐藏时暂停） */
(function () {
  "use strict";
  const reduce = () => window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const WARM = ["255,176,80", "255,124,52", "255,222,150", "255,96,60"];
  const COOL = ["120,255,200", "150,220,255"];

  function embers(canvas) {
    if (!canvas || !canvas.getContext || reduce()) return;
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let w = 0;
    let h = 0;
    let parts = [];
    let raf = 0;
    let last = 0;
    let running = true;
    const spawn = fresh => {
      const cool = Math.random() < 0.18;
      const c = cool ? COOL[(Math.random() * COOL.length) | 0] : WARM[(Math.random() * WARM.length) | 0];
      return { x: Math.random() * w, y: fresh ? Math.random() * h : h + 10, vy: 18 + Math.random() * 46, drift: 10 + Math.random() * 26, phase: Math.random() * 6.28, size: 0.8 + Math.random() * 2.2, life: 0, max: 5 + Math.random() * 7, c };
    };
    function resize() {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = w < 700 ? 26 : 60;
      parts = Array.from({ length: n }, () => spawn(true));
    }
    function frame(t) {
      raf = 0;
      if (!running) return;
      const dt = Math.min(0.05, (t - (last || t)) / 1000);
      last = t;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        p.life += dt;
        p.y -= p.vy * dt;
        p.x += Math.sin(t / 900 + p.phase) * p.drift * dt;
        if (p.life > p.max || p.y < -20) {
          parts[i] = spawn(false);
          continue;
        }
        const k = p.life / p.max;
        const a = Math.min(1, k * 5) * (1 - k) * 0.9;
        const r = p.size * 4;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        g.addColorStop(0, `rgba(${p.c},${a})`);
        g.addColorStop(0.35, `rgba(${p.c},${a * 0.35})`);
        g.addColorStop(1, `rgba(${p.c},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(p.x - r, p.y - r, r * 2, r * 2);
      }
      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(frame);
    }
    resize();
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", () => {
      running = document.visibilityState === "visible";
      if (running && !raf) {
        last = 0;
        raf = requestAnimationFrame(frame);
      }
    });
    raf = requestAnimationFrame(frame);
  }

  let burstCanvas = null;
  let bursts = [];
  let burstRaf = 0;
  function burst(x, y, { count = 60, power = 1, colors = ["255,200,90", "255,110,60", "255,240,200", "110,255,200"] } = {}) {
    if (reduce()) return;
    if (!burstCanvas) {
      burstCanvas = document.createElement("canvas");
      burstCanvas.className = "fx-burst";
      burstCanvas.setAttribute("aria-hidden", "true");
      document.body.appendChild(burstCanvas);
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const cw = Math.round(window.innerWidth * dpr);
    const ch = Math.round(window.innerHeight * dpr);
    if (burstCanvas.width !== cw || burstCanvas.height !== ch) {
      burstCanvas.width = cw;
      burstCanvas.height = ch;
    }
    const parts = Array.from({ length: count }, () => {
      const ang = Math.random() * Math.PI * 2;
      const sp = (120 + Math.random() * 380) * power;
      return { x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp - 80 * power, life: 0, max: 0.6 + Math.random() * 0.8, size: 1 + Math.random() * 2.6, c: colors[(Math.random() * colors.length) | 0] };
    });
    bursts.push({ x, y, t: 0, parts, power });
    if (!burstRaf) {
      let last = 0;
      const ctx = burstCanvas.getContext("2d");
      const step = t => {
        const dt = Math.min(0.05, (t - (last || t)) / 1000);
        last = t;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, burstCanvas.width, burstCanvas.height);
        ctx.globalCompositeOperation = "lighter";
        for (const b of bursts) {
          b.t += dt;
          // 冲击波光环
          if (b.t < 0.5) {
            const k = b.t / 0.5;
            ctx.strokeStyle = `rgba(255,214,140,${(1 - k) * 0.6})`;
            ctx.lineWidth = 3 * (1 - k) + 0.5;
            ctx.beginPath();
            ctx.arc(b.x, b.y, 10 + k * 140 * b.power, 0, Math.PI * 2);
            ctx.stroke();
          }
          for (const p of b.parts) {
            if (p.life >= p.max) continue;
            p.life += dt;
            p.vx *= 0.96;
            p.vy = p.vy * 0.96 + 420 * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            const a = Math.max(0, 1 - p.life / p.max);
            ctx.fillStyle = `rgba(${p.c},${a})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * (0.6 + a * 0.6), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.globalCompositeOperation = "source-over";
        bursts = bursts.filter(b => b.t < 1.6);
        if (bursts.length) burstRaf = requestAnimationFrame(step);
        else {
          burstRaf = 0;
          ctx.clearRect(0, 0, burstCanvas.width, burstCanvas.height);
        }
      };
      burstRaf = requestAnimationFrame(step);
    }
  }
  function burstAt(el, opts) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    burst(r.left + r.width / 2, r.top + r.height / 2, opts);
  }

  window.FX = { embers, burst, burstAt };
  document.addEventListener("DOMContentLoaded", () => embers(document.getElementById("embers")));
})();
