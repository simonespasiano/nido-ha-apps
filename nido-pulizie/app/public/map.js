/* Disegno della mappa del robot su canvas: stanze, ostacoli, base, robot e percorso. */
(function () {
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const hex = (h, a) => {
    const m = h.replace('#', '');
    const n = parseInt(m.length === 3 ? m.split('').map(c => c + c).join('') : m, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, Math.round(a * 255)];
  };

  function decode(map) {
    if (map._grid) return map._grid;
    const g = new Int32Array(map.width * map.height);
    let i = 0;
    for (let k = 0; k < map.rle.length; k += 2) { g.fill(map.rle[k], i, i + map.rle[k + 1]); i += map.rle[k + 1]; }
    map._grid = g;
    return g;
  }

  function roomColor(map, id) {
    const idx = map.rooms.findIndex(r => r.id === id);
    return css(`--c${(idx < 0 ? id : idx) % 7 + 1}`) || '#888888';
  }

  /** opts: { selected:Set<number>, path:[[x,y]], robot:{x,y,heading}, maxHeight, dim:Set<number> } */
  function draw(canvas, map, opts = {}) {
    const grid = decode(map);
    const W = map.width, H = map.height;
    // ritaglio sulla parte occupata della griglia
    let x0 = W, y0 = H, x1 = 0, y1 = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (grid[y * W + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (x1 < x0) { x0 = 0; y0 = 0; x1 = W - 1; y1 = H - 1; }
    const pad = 3;
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(W - 1, x1 + pad); y1 = Math.min(H - 1, y1 + pad);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;

    const off = document.createElement('canvas');
    off.width = cw; off.height = ch;
    const octx = off.getContext('2d');
    const img = octx.createImageData(cw, ch);
    const floor = hex(css('--floor'), 1), obst = hex(css('--obst'), 1), wall = hex(css('--wall'), 1);
    const colors = new Map();
    for (const r of map.rooms) {
      const c = roomColor(map, r.id);
      const sel = opts.selected?.has(r.id), dim = opts.dim?.has(r.id);
      colors.set(r.id, { fill: hex(c, sel ? 0.62 : dim ? 0.12 : 0.28), edge: hex(c, sel ? 1 : 0.7) });
    }
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const gy = y1 - y; // l'asse y del robot va verso l'alto
      const v = grid[gy * W + (x + x0)];
      let px = null;
      if (v === 1) px = floor;
      else if (v === 2) px = obst;
      else if (v === 3) px = wall;
      else if (v >= 10) {
        const edge = v >= 1000, id = (edge ? v - 1000 : v) - 10;
        const c = colors.get(id);
        px = c ? (edge ? c.edge : c.fill) : floor;
      }
      if (px) img.data.set(px, (y * cw + x) * 4);
    }
    octx.putImageData(img, 0, 0);

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.parentElement.clientWidth || 600;
    const maxH = opts.maxHeight ?? 520;
    const scale = Math.min(cssW / cw, maxH / ch);
    canvas.style.width = `${Math.round(cw * scale)}px`;
    canvas.style.height = `${Math.round(ch * scale)}px`;
    canvas.width = Math.round(cw * scale * dpr);
    canvas.height = Math.round(ch * scale * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, 0, 0, cw * scale, ch * scale);

    const tx = gx => (gx - x0 + 0.5) * scale;
    const ty = gy => (y1 - gy + 0.5) * scale;

    // percorso
    if (opts.path?.length > 1) {
      ctx.strokeStyle = css('--accent');
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = Math.max(1.2, scale * 0.6);
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      opts.path.forEach(([x, y], i) => i ? ctx.lineTo(tx(x), ty(y)) : ctx.moveTo(tx(x), ty(y)));
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // nomi delle stanze
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.max(10, Math.min(14, scale * 3.2))}px system-ui, sans-serif`;
    for (const r of map.rooms) {
      if (r.cx == null) continue;
      const x = tx(r.cx), y = ty(r.cy);
      ctx.lineWidth = 3; ctx.strokeStyle = css('--card'); ctx.strokeText(r.name, x, y);
      ctx.fillStyle = css('--ink'); ctx.fillText(r.name, x, y);
    }

    // base
    if (map.dock) {
      const x = tx(map.dock.x), y = ty(map.dock.y), s = Math.max(7, scale * 2.2);
      ctx.fillStyle = css('--ink');
      ctx.beginPath(); ctx.roundRect(x - s, y - s * 0.7, s * 2, s * 1.4, 3); ctx.fill();
      ctx.fillStyle = css('--card');
      ctx.fillRect(x - s * 0.5, y - 1, s, 2);
    }

    // robot
    if (opts.robot) {
      const x = tx(opts.robot.x), y = ty(opts.robot.y), r = Math.max(7, scale * 2.6);
      ctx.fillStyle = css('--card'); ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      const h = opts.robot.heading || 0;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(h) * r, y - Math.sin(h) * r); ctx.stroke();
    }

    canvas._view = { x0, y1, scale, W, map };
  }

  function roomAt(canvas, ev) {
    const v = canvas._view;
    if (!v) return null;
    const rect = canvas.getBoundingClientRect();
    const gx = Math.floor((ev.clientX - rect.left) / v.scale) + v.x0;
    const gy = v.y1 - Math.floor((ev.clientY - rect.top) / v.scale);
    const g = decode(v.map);
    if (gx < 0 || gy < 0 || gx >= v.map.width || gy >= v.map.height) return null;
    const val = g[gy * v.W + gx];
    if (val < 10) return null;
    const id = (val >= 1000 ? val - 1000 : val) - 10;
    return v.map.rooms.find(r => r.id === id) ?? null;
  }

  window.NidoMap = { draw, roomAt, roomColor };
})();
