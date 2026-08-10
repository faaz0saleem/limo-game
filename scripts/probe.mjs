/**
 * Physics tuning probe. Boots the game headless, drives a scripted profile and
 * prints the numbers that matter for feel: acceleration, corner behaviour, how
 * far the cargo leans and how hard the tail whips.
 *
 * Usage: node scripts/probe.mjs [level]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const level = Number(process.argv[2] || 3);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function serve(port) {
  const server = createServer(async (req, res) => {
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
  return new Promise((r) => server.listen(port, () => r(server)));
}

const main = async () => {
  const port = 8124;
  const server = await serve(port);
  const { chromium } = require(join(require('node:child_process').execSync('npm root -g').toString().trim(), 'playwright'));
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.error('PAGE ERROR', String(e)));

  await page.goto(`http://localhost:${port}/index.html`);
  await page.waitForSelector('#screen-menu.active');
  await page.evaluate((lv) => window.__limo.startLevel(lv), level);
  await page.waitForFunction(() => window.__limo.state === 'playing', null, { timeout: 15000 });

  // Straight-line acceleration
  const accel = await page.evaluate(async () => {
    const g = window.__limo;
    const samples = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 2500) {
      samples.push(g.limo.speed);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return {
      topSpeed: Math.max(...samples),
      after1s: samples[Math.min(60, samples.length - 1)],
    };
  });

  const watch = (ms) =>
    page.evaluate(async (duration) => {
      const g = window.__limo;
      let maxTilt = 0;
      let maxDrift = 0;
      let maxSlip = 0;
      let maxJoint = 0;
      let minSpeed = Infinity;
      let maxSpeed = 0;
      const before = g.rig.intact;
      const t0 = performance.now();
      while (performance.now() - t0 < duration) {
        maxTilt = Math.max(maxTilt, g.rig.worstTilt);
        maxDrift = Math.max(maxDrift, g.limo.driftAngle);
        maxSlip = Math.max(maxSlip, g.limo.slip);
        minSpeed = Math.min(minSpeed, g.limo.speed);
        maxSpeed = Math.max(maxSpeed, g.limo.speed);
        const segs = g.limo.segments;
        for (let i = 0; i < segs.length - 1; i++) {
          let d = segs[i + 1].body.angle - segs[i].body.angle;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          maxJoint = Math.max(maxJoint, Math.abs(d));
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
      const r2 = (n) => Math.round(n * 100) / 100;
      return {
        maxTilt: r2(maxTilt),
        maxDrift: r2(maxDrift),
        maxSlip: r2(maxSlip),
        maxJoint: r2(maxJoint),
        minSpeed: r2(minSpeed),
        maxSpeed: r2(maxSpeed),
        drops: before - g.rig.intact,
      };
    }, ms);

  // Slalom: what a player actually does through city corners.
  const slalomTask = watch(4000);
  for (let i = 0; i < 5; i++) {
    const key = i % 2 ? 'ArrowLeft' : 'ArrowRight';
    await page.keyboard.down(key);
    await page.waitForTimeout(400);
    await page.keyboard.up(key);
    await page.waitForTimeout(400);
  }
  const slalom = await slalomTask;

  // Sustained full-lock corner: watch cargo lean and tail whip.
  await page.keyboard.down('ArrowLeft');
  const corner = await page.evaluate(async () => {
    const g = window.__limo;
    let maxTilt = 0;
    let maxDrift = 0;
    let maxSlip = 0;
    let maxJoint = 0;
    let drops = 0;
    const before = g.rig.intact;
    const t0 = performance.now();
    while (performance.now() - t0 < 2600) {
      maxTilt = Math.max(maxTilt, g.rig.worstTilt);
      maxDrift = Math.max(maxDrift, g.limo.driftAngle);
      maxSlip = Math.max(maxSlip, g.limo.slip);
      const segs = g.limo.segments;
      for (let i = 0; i < segs.length - 1; i++) {
        let d = segs[i + 1].body.angle - segs[i].body.angle;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        maxJoint = Math.max(maxJoint, Math.abs(d));
      }
      await new Promise((r) => requestAnimationFrame(r));
    }
    drops = before - g.rig.intact;
    return { maxTilt, maxDrift, maxSlip, maxJoint, drops, speed: g.limo.speed };
  });
  await page.keyboard.up('ArrowLeft');

  console.log(`\nLevel ${level} probe (${await page.evaluate(() => window.__limo.limo.segmentCount)} segments, ${await page.evaluate(() => window.__limo.rig.total)} cargo)`);
  console.log('  straight   :', JSON.stringify(accel));
  console.log('  slalom     :', JSON.stringify(slalom));
  console.log('  full lock  :', JSON.stringify(corner));

  await browser.close();
  server.close();
};

main();
