/**
 * Track generator audit.
 *
 * Generates every level (plus extra seeds) and asserts the hard invariant:
 * no kerb wall may ever cross the driving line, because that makes a contract
 * physically impossible. Also reports how long each layout came out and how
 * many generation attempts it needed.
 *
 * Usage: node scripts/track-audit.mjs [levels] [seedsPerLevel]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const levels = Number(process.argv[2] || 12);
const seedsPer = Number(process.argv[3] || 6);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const server = await new Promise((r) => {
  const s = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/') p = '/index.html';
      const full = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ''));
      const body = await readFile(full);
      res.writeHead(200, {
        'content-type': (MIME[extname(full)] || 'application/octet-stream') + '; charset=utf-8',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  s.listen(8127, () => r(s));
});

const { chromium } = require(
  join(require('node:child_process').execSync('npm root -g').toString().trim(), 'playwright')
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (e) => console.error('PAGE ERROR', String(e)));
await page.goto(`http://localhost:8127/index.html`);
await page.waitForSelector('#screen-menu.active');

const results = await page.evaluate(
  async ({ levels, seedsPer }) => {
    const { generateTrack } = await import('/src/track.js');
    const { getLevel } = await import('/src/levels.js');
    const M = window.Matter;

    const cross = (p1, p2, p3, p4) => {
      const d = (p4.y - p3.y) * (p2.x - p1.x) - (p4.x - p3.x) * (p2.y - p1.y);
      if (Math.abs(d) < 1e-9) return false;
      const ua = ((p4.x - p3.x) * (p1.y - p3.y) - (p4.y - p3.y) * (p1.x - p3.x)) / d;
      const ub = ((p2.x - p1.x) * (p1.y - p3.y) - (p2.y - p1.y) * (p1.x - p3.x)) / d;
      return ua > 0.002 && ua < 0.998 && ub > 0.002 && ub < 0.998;
    };

    const rows = [];
    for (let lv = 1; lv <= levels; lv++) {
      const def = getLevel(lv);
      for (let s = 0; s < seedsPer; s++) {
        const world = M.Composite.create();
        const t0 = performance.now();
        const track = generateTrack(world, { level: lv, seed: def.seed + s * 104729 });
        const genMs = performance.now() - t0;

        // Independent re-check of the invariant, against the real wall bodies.
        let blocked = 0;
        for (const w of track.walls) {
          const v = w.vertices;
          const a = { x: (v[0].x + v[3].x) / 2, y: (v[0].y + v[3].y) / 2 };
          const b = { x: (v[1].x + v[2].x) / 2, y: (v[1].y + v[2].y) / 2 };
          for (let i = 0; i < track.samples.length - 1; i++) {
            if (cross(a, b, track.samples[i], track.samples[i + 1])) {
              blocked++;
              break;
            }
          }
        }

        // Minimum corridor width actually available anywhere on the route.
        let narrowest = Infinity;
        for (const smp of track.samples) narrowest = Math.min(narrowest, smp.w);

        rows.push({
          level: lv,
          seedOffset: s,
          samples: track.samples.length,
          lengthUnits: Math.round(track.length),
          attempts: track.attempts,
          walls: track.walls.length,
          blocked,
          narrowest: Math.round(narrowest),
          genMs: Math.round(genMs),
        });
      }
    }
    return rows;
  },
  { levels, seedsPer }
);

let blockedTotal = 0;
let worstAttempts = 0;
let slowest = 0;
const byLevel = new Map();
for (const r of results) {
  blockedTotal += r.blocked;
  worstAttempts = Math.max(worstAttempts, r.attempts);
  slowest = Math.max(slowest, r.genMs);
  if (!byLevel.has(r.level)) byLevel.set(r.level, []);
  byLevel.get(r.level).push(r);
  if (r.blocked) {
    console.log(`  BLOCKED L${r.level} seed+${r.seedOffset}: ${r.blocked} wall(s) cross the road`);
  }
}

for (const [lv, rows] of byLevel) {
  const samples = rows.map((r) => r.samples);
  const walls = rows.map((r) => r.walls);
  console.log(
    `L${String(lv).padStart(2)}  samples ${Math.min(...samples)}-${Math.max(...samples)}  ` +
      `walls ${Math.min(...walls)}-${Math.max(...walls)}  ` +
      `attempts ${Math.max(...rows.map((r) => r.attempts))}  ` +
      `narrowest ${Math.min(...rows.map((r) => r.narrowest))}u  ` +
      `gen ${Math.max(...rows.map((r) => r.genMs))}ms`
  );
}

console.log(
  `\n${results.length} layouts generated · ${blockedTotal} blocked · ` +
    `max ${worstAttempts} attempts · slowest ${slowest}ms`
);
if (blockedTotal > 0) process.exitCode = 1;

await browser.close();
server.close();
