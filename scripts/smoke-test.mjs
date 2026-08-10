/**
 * Headless playthrough smoke test.
 *
 * Boots the real game in Chromium, drives it with synthetic key presses and
 * asserts that: nothing throws, the physics actually moves the limo, cargo tilt
 * responds to cornering, and the run can reach a result screen.
 *
 * Usage:  node scripts/smoke-test.mjs [--headed] [--shots]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wantShots = process.argv.includes('--shots');
const headed = process.argv.includes('--headed');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
};

function serve(port) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let path = decodeURIComponent(url.pathname);
      if (path === '/') path = '/index.html';
      const full = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
      if (!full.startsWith(root)) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const body = await readFile(full);
      res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

function resolvePlaywright() {
  try {
    return require('playwright');
  } catch {
    // Fall back to the global install used by CI images.
    const { execSync } = require('node:child_process');
    const globalRoot = execSync('npm root -g').toString().trim();
    return require(join(globalRoot, 'playwright'));
  }
}

const assert = (cond, msg) => {
  if (!cond) throw new Error('ASSERT: ' + msg);
  console.log('  ✓ ' + msg);
};

const main = async () => {
  const port = 8123;
  const server = await serve(port);
  const { chromium } = resolvePlaywright();
  const browser = await chromium.launch({ headless: !headed });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  const errors = [];
  // The Poki SDK is loaded from their CDN and is expected to be unreachable
  // offline — the game is built to fall back to a stub, so that is not a bug.
  const ignorable = (text) =>
    /poki|ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|net::ERR_/i.test(
      text
    );
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !ignorable(m.text())) errors.push(m.text());
  });

  const press = async (key, ms) => {
    await page.keyboard.down(key);
    await page.waitForTimeout(ms);
    await page.keyboard.up(key);
  };

  try {
    await page.goto(`http://localhost:${port}/index.html`, { waitUntil: 'load' });

    await page.waitForSelector('#screen-menu.active', { timeout: 15000 });
    assert(true, 'menu screen reached');

    await page.click('#btn-play');
    await page.waitForFunction(() => window.__limo && window.__limo.limo, null, { timeout: 8000 });
    assert(true, 'level started and limo built');

    const built = await page.evaluate(() => ({
      segments: window.__limo.limo.segmentCount,
      joints: window.__limo.limo.joints.length,
      cargo: window.__limo.rig.total,
      walls: window.__limo.track.walls.length,
      samples: window.__limo.track.samples.length,
      zones: window.__limo.track.zones.length,
      traffic: window.__limo.traffic.cars.length,
      props: window.__limo.track.props.length,
    }));
    console.log('  · built:', JSON.stringify(built));
    assert(built.joints === built.segments - 1, 'one joint per segment gap');
    assert(built.walls > 20, 'track walls generated');
    assert(built.zones > 0, 'hazard zones generated');
    assert(built.traffic > 0, 'civilian traffic spawned');

    // Wait out the countdown, then drive.
    await page.waitForFunction(() => window.__limo.state === 'playing', null, { timeout: 10000 });
    const start = await page.evaluate(() => ({ ...window.__limo.limo.cab.position }));
    await page.waitForTimeout(1200);
    const afterStraight = await page.evaluate(() => ({
      pos: { ...window.__limo.limo.cab.position },
      speed: window.__limo.limo.speed,
    }));
    const moved = Math.hypot(afterStraight.pos.x - start.x, afterStraight.pos.y - start.y);
    console.log(`  · travelled ${moved.toFixed(1)} units, speed ${afterStraight.speed.toFixed(2)}`);
    assert(moved > 100, 'limo accelerates under auto-throttle');
    assert(afterStraight.speed > 3, 'reaches cruising speed');

    // Hard cornering should load the cargo up.
    await press('ArrowLeft', 900);
    // Peak, not instantaneous — the load settles back the moment the wheel is
    // straightened, so sampling after the release would read almost nothing.
    const cornering = await page.evaluate(() => ({
      tilt: Math.max(...window.__limo.rig.items.map((i) => i.peakTilt)),
      drift: window.__limo.limo.maxDriftAngle,
      slip: window.__limo.limo.slip,
    }));
    console.log(
      `  · cornering: tilt ${cornering.tilt.toFixed(2)}, maxDrift ${cornering.drift.toFixed(2)} rad`
    );
    assert(cornering.tilt > 0.05, 'cargo tilts under cornering load');

    // Provoke a drift and check smoke/skids appear.
    await page.keyboard.down('Space');
    await press('ArrowRight', 1100);
    await press('ArrowLeft', 1100);
    await page.keyboard.up('Space');
    const drifting = await page.evaluate(() => ({
      maxDrift: window.__limo.limo.maxDriftAngle,
      driftScore: window.__limo.limo.driftScore,
      skids: window.__limo.particles.skids.length,
      alive: window.__limo.particles.pool.filter((p) => p.alive).length,
    }));
    console.log('  · drift:', JSON.stringify(drifting));
    assert(drifting.maxDrift > 0.1, 'drift angle recorded');

    if (wantShots) {
      await page.screenshot({ path: join(root, 'test-artifacts', 'gameplay.png') });
    }

    // Teleport to the finish line to exercise the result flow.
    await page.evaluate(() => window.__limo.placeLimoAt(window.__limo.track.finish.index - 3));
    const afterTeleport = await page.evaluate(() => window.__limo.rig.intact);
    assert(afterTeleport === 1, 'repositioning the limo does not tear off its cargo');
    await page.waitForFunction(() => window.__limo.state === 'result', null, { timeout: 12000 });
    const res = await page.evaluate(() => ({
      delivered: window.__limo.result.delivered,
      total: window.__limo.result.total,
      cash: window.__limo.result.cash,
      stars: window.__limo.result.stars,
    }));
    console.log('  · result:', JSON.stringify(res));
    assert(res.delivered === true, 'reaching the finish delivers the run');
    assert(res.total > 0, 'score computed');

    if (wantShots) {
      await page.screenshot({ path: join(root, 'test-artifacts', 'result.png') });
    }

    // Strap-break behaviour, on a level with enough cargo that losing one item
    // does not immediately end the run.
    await page.evaluate(() => window.__limo.startLevel(3));
    await page.waitForFunction(() => window.__limo.state === 'playing', null, { timeout: 12000 });
    const dropped = await page.evaluate(() => {
      const g = window.__limo;
      const item = g.rig.items[0];
      const before = g.rig.intact;
      item.detach(g._events(), 'test');
      return {
        attached: item.attached,
        constraint: item.constraint,
        before,
        after: g.rig.intact,
        collidesNow: item.body.collisionFilter.mask !== 0,
        stillPlaying: g.state === 'playing',
      };
    });
    assert(dropped.attached === false && dropped.constraint === null, 'cargo strap breaks cleanly');
    assert(dropped.after === dropped.before - 1, 'losing one item leaves the rest strapped on');
    assert(dropped.collidesNow, 'dropped cargo starts colliding with the world');
    assert(dropped.stillPlaying, 'losing one of several items does not end the run');

    if (wantShots) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(root, 'test-artifacts', 'cargo-drop.png') });
    }

    assert(errors.length === 0, `no console/page errors (saw ${errors.length})`);
    if (errors.length) console.error(errors.join('\n'));

    console.log('\nSmoke test passed.');
  } catch (err) {
    console.error('\nSmoke test FAILED:', err.message);
    if (errors.length) console.error('Page errors:\n' + errors.join('\n'));
    try {
      await page.screenshot({ path: join(root, 'test-artifacts', 'failure.png') });
    } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
};

main();
