/** Throwaway diagnostic: find wall segments that cut across the road corridor. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const level = Number(process.argv[2] || 1);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = await new Promise((r) => {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const full = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
      const body = await readFile(full);
      res.writeHead(200, { 'content-type': (MIME[extname(full)] || 'application/octet-stream') + '; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  s.listen(8125, () => r(s));
});

const { chromium } = require(
  join(require('node:child_process').execSync('npm root -g').toString().trim(), 'playwright')
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('PAGE ERROR', String(e)));
await page.goto('http://localhost:8125/index.html');
await page.waitForSelector('#screen-menu.active');

const out = await page.evaluate(async (lv) => {
  const g = window.__limo;
  g.startLevel(lv);
  await new Promise((r) => setTimeout(r, 250));
  const t = g.track;

  const segInt = (p1, p2, p3, p4) => {
    const d = (p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y);
    if (Math.abs(d) < 1e-9) return false;
    const ua = ((p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)) / d;
    const ub = ((p2.x - p1.x) * (p1.y - p3.y) - (p2.y - p1.y) * (p1.x - p3.x)) / d;
    return ua > 0.001 && ua < 0.999 && ub > 0.001 && ub < 0.999;
  };

  // Centreline segments, shrunk slightly so shared endpoints don't count.
  const centre = [];
  for (let i = 0; i < t.samples.length - 1; i++) {
    centre.push([t.samples[i], t.samples[i + 1], i]);
  }

  const bad = [];
  for (const w of t.walls) {
    // Wall body long axis from its vertices.
    const v = w.vertices;
    const mid1 = { x: (v[0].x + v[3].x) / 2, y: (v[0].y + v[3].y) / 2 };
    const mid2 = { x: (v[1].x + v[2].x) / 2, y: (v[1].y + v[2].y) / 2 };
    for (const [a, b, i] of centre) {
      if (segInt(mid1, mid2, a, b)) {
        bad.push({
          crossesSampleIdx: i,
          from: [Math.round(mid1.x), Math.round(mid1.y)],
          to: [Math.round(mid2.x), Math.round(mid2.y)],
          len: Math.round(Math.hypot(mid2.x - mid1.x, mid2.y - mid1.y)),
        });
        break;
      }
    }
  }

  // Which edge indices do the offending endpoints correspond to?
  const locate = (pt, edge) => {
    let best = -1;
    let bd = Infinity;
    edge.forEach((p, i) => {
      const d = Math.hypot(p.x - pt[0], p.y - pt[1]);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return { idx: best, dist: Math.round(bd) };
  };

  return {
    level: lv,
    samples: t.samples.length,
    walls: t.walls.length,
    badCount: bad.length,
    bad: bad.slice(0, 8).map((b) => ({
      ...b,
      fromLeft: locate(b.from, t.leftEdge),
      toLeft: locate(b.to, t.leftEdge),
      fromRight: locate(b.from, t.rightEdge),
      toRight: locate(b.to, t.rightEdge),
    })),
  };
}, level);

console.log(JSON.stringify(out, null, 1));
await browser.close();
server.close();
