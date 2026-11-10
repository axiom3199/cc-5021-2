import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

// chromium system libraries extracted locally (no root in this environment)
const LIBDIRS = ['/tmp/chromium-libs/usr/lib/aarch64-linux-gnu', '/tmp/chromium-libs/lib/aarch64-linux-gnu'];
if (LIBDIRS.every((d) => fs.existsSync(d))) {
  process.env.LD_LIBRARY_PATH = LIBDIRS.join(':') + (process.env.LD_LIBRARY_PATH ? ':' + process.env.LD_LIBRARY_PATH : '');
}
const { chromium } = await import('playwright');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4631;

async function probe(url) {
  try { return (await fetch(url)).ok; } catch { return false; }
}

function waitServer(url, timeout = 90000) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(url);
        if (r.ok) return resolve();
      } catch {}
      if (Date.now() - t0 > timeout) return reject(new Error('server timeout'));
      setTimeout(tick, 300);
    };
    tick();
  });
}

// acceptance thresholds per scenario
const LIMITS = {
  'flat-1x':            { maxPenM: 0.020, maxKneeJumpDeg: 8,  maxHipJumpM: 0.020 },
  'slope-up-1x':        { maxPenM: 0.025, maxKneeJumpDeg: 8,  maxHipJumpM: 0.020 },
  'slope-down-1x':      { maxPenM: 0.025, maxKneeJumpDeg: 8,  maxHipJumpM: 0.020 },
  'steps-up-1x':        { maxPenM: 0.035, maxKneeJumpDeg: 12, maxHipJumpM: 0.025 },
  'steps-down-1x':      { maxPenM: 0.035, maxKneeJumpDeg: 12, maxHipJumpM: 0.025 },
  'mixed-1x':           { maxPenM: 0.035, maxKneeJumpDeg: 12, maxHipJumpM: 0.025 },
  'hole-1x (单脚悬空)': { maxPenM: 0.025, maxKneeJumpDeg: 16, maxHipJumpM: 0.030 },
  'mixed-0.5x':         { maxPenM: 0.035, maxKneeJumpDeg: 8,  maxHipJumpM: 0.020 },
  'mixed-2x':           { maxPenM: 0.045, maxKneeJumpDeg: 24, maxHipJumpM: 0.045 },
};

let server = null;
if (await probe(`http://127.0.0.1:${PORT}/`)) {
  console.log('reusing already-running dev server');
} else {
  server = spawn('npx', ['vite', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort', '--logLevel', 'warn'],
    { cwd: root, stdio: 'pipe' });
  server.stderr.on('data', (d) => process.stderr.write(d));
}

let browser;
let fail = 0;
try {
  await waitServer(`http://127.0.0.1:${PORT}/`);
  browser = await chromium.launch({
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForFunction('window.__ready === true', null, { timeout: 30000 });

  // canvas must be actually rendering (not a blank frame)
  const px = await page.evaluate('window.__samplePixels()');
  console.log(`canvas pixels: mean=${px.mean.toFixed(1)} std=${px.std.toFixed(1)}`);
  if (px.std < 5) throw new Error('canvas appears blank');

  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(root, 'test', 'shot-mixed.png') });

  await page.evaluate(`window.__app.setTerrain('steps-up'); window.__app.setToggles({ ghost: true, contacts: true, targets: true });`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(root, 'test', 'shot-steps-ghost.png') });

  await page.evaluate(`window.__app.setTerrain('hole'); window.__app.setToggles({ ghost: false });`);
  await page.waitForTimeout(3200);
  await page.screenshot({ path: path.join(root, 'test', 'shot-hole.png') });

  await page.evaluate(`window.__app.setTerrain('slope-up'); window.__app.setToggles({ correct: false });`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(root, 'test', 'shot-slope-nocorrect.png') });
  await page.evaluate(`window.__app.setToggles({ correct: true });`);

  const results = await page.evaluate('window.__runTests()');
  console.log('\nscenario results:');
  for (const r of results) {
    const lim = LIMITS[r.name] || {};
    const bad = [];
    if (lim.maxPenM !== undefined && r.maxPenM > lim.maxPenM) bad.push(`pen ${(r.maxPenM * 100).toFixed(2)}cm > ${lim.maxPenM * 100}cm`);
    if (lim.maxKneeJumpDeg !== undefined && r.maxKneeJumpDeg > lim.maxKneeJumpDeg) bad.push(`kneeJump ${r.maxKneeJumpDeg.toFixed(2)}° > ${lim.maxKneeJumpDeg}°`);
    if (lim.maxHipJumpM !== undefined && r.maxHipJumpM > lim.maxHipJumpM) bad.push(`hipJump ${(r.maxHipJumpM * 1000).toFixed(1)}mm > ${lim.maxHipJumpM * 1000}mm`);
    if (Number.isNaN(r.maxPenM) || Number.isNaN(r.maxKneeJumpDeg)) bad.push('NaN metric');
    const ok = bad.length === 0;
    if (!ok) fail++;
    console.log(
      `${ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(18)} pen=${(r.maxPenM * 100).toFixed(2)}cm rms=${(r.rmsPenM * 100).toFixed(2)}cm ` +
      `kneeJump=${r.maxKneeJumpDeg.toFixed(2)}° hipJump=${(r.maxHipJumpM * 1000).toFixed(1)}mm miss=${r.misses} clamp=${r.clamps}` +
      (ok ? '' : `   <-- ${bad.join('; ')}`)
    );
  }
  // hole scenario must actually produce sample misses (fallback path exercised)
  const hole = results.find((r) => r.name.startsWith('hole'));
  if (!hole || hole.misses === 0) { console.log('FAIL  hole scenario produced no sample misses'); fail++; }

  await browser.close();
  if (server) server.kill();
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error(e);
  if (browser) await browser.close();
  if (server) server.kill();
  process.exit(1);
}
