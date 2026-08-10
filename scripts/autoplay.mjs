/**
 * Autopilot balance check.
 *
 * Drives every level with a simple centerline-following bot and reports whether
 * the contract is completable, how much time is left, and how much cargo
 * survives. The bot is deliberately mediocre — no racing line, no braking — so
 * a level it can finish is comfortably human-completable, and a level it fails
 * on time is a red flag.
 *
 * Usage: node scripts/autoplay.mjs [firstLevel] [lastLevel]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const first = Number(process.argv[2] || 1);
const last = Number(process.argv[3] || 10);
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
  s.listen(8126, () => r(s));
});

const { chromium } = require(
  join(require('node:child_process').execSync('npm root -g').toString().trim(), 'playwright')
);
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('PAGE ERROR', String(e)));

await page.goto('http://localhost:8126/index.html');
await page.waitForSelector('#screen-menu.active');

// Install the bot once; it takes over Input whenever `window.__bot` is on.
await page.evaluate(() => {
  const angleDiff = (a, b) => {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return d;
  };
  window.__bot = false;
  window.__botStats = null;
  const tick = () => {
    const g = window.__limo;
    if (window.__bot && g && g.limo && g.track && g.state === 'playing') {
      const cab = g.limo.cab;
      const speed = g.limo.speed;
      const ahead = Math.round(3 + speed * 0.9);
      const s = g.track.sample(g.playerIndex + ahead);
      const err = angleDiff(Math.atan2(s.y - cab.position.y, s.x - cab.position.x), cab.angle);
      g.input.left = err < -0.04;
      g.input.right = err > 0.04;
      // Straight-line only turbo, and never while the cargo is close to going.
      g.input.boostHeld = Math.abs(err) < 0.12 && g.rig.worstTilt < 0.45;
      const st = window.__botStats;
      if (st) {
        st.maxTilt = Math.max(st.maxTilt, g.rig.worstTilt);
        st.maxDrift = Math.max(st.maxDrift, g.limo.driftAngle);
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const rows = [];
for (let lv = first; lv <= last; lv++) {
  const out = await page.evaluate(async (level) => {
    const g = window.__limo;
    g.startLevel(level);
    window.__botStats = { maxTilt: 0, maxDrift: 0 };
    const t0 = performance.now();
    while (g.state !== 'result' && performance.now() - t0 < 180000) {
      await new Promise((r) => setTimeout(r, 60));
      window.__bot = true;
    }
    window.__bot = false;
    const r2 = (n) => Math.round(n * 100) / 100;
    return {
      level,
      name: g.levelDef.name,
      segments: g.levelDef.segments,
      limit: g.levelDef.timeLimit,
      delivered: g.result ? g.result.delivered : false,
      reason: g.finishReason,
      timeLeft: r2(g.timeLeft),
      intact: g.rig.intact,
      total: g.rig.total,
      wallHits: g.wallHits,
      progress: r2(g.track.progressAt(g.playerIndex)),
      maxDrift: r2((window.__botStats.maxDrift * 180) / Math.PI),
      maxTilt: r2(window.__botStats.maxTilt),
      score: g.result ? g.result.total : 0,
      stars: g.result ? g.result.stars : 0,
    };
  }, lv);
  rows.push(out);
  console.log(
    `L${String(out.level).padStart(2)} ${out.delivered ? '✅' : '❌'} ` +
      `${out.name.padEnd(22)} seg=${out.segments} ` +
      `limit=${String(out.limit).padStart(3)}s left=${String(out.timeLeft).padStart(5)} ` +
      `prog=${String(out.progress).padStart(4)} cargo=${out.intact}/${out.total} ` +
      `walls=${String(out.wallHits).padStart(3)} drift=${out.maxDrift}° tilt=${out.maxTilt} ` +
      `score=${out.score}`
  );
}

const failed = rows.filter((r) => !r.delivered);
console.log(`\n${rows.length - failed.length}/${rows.length} levels completed by the bot.`);
if (failed.length) {
  console.log('Failed: ' + failed.map((r) => `L${r.level}(${r.reason}@${r.progress})`).join(', '));
}

await browser.close();
server.close();
