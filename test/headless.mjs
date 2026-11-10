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

  // ---- moving-platform acceptance (UI + contact semantics) ----
  const check = (name, cond, detail = '') => {
    if (cond) console.log(`PASS  ${name}`);
    else { fail++; console.log(`FAIL  ${name} ${detail}`); }
  };

  // rotating disc: an object-local anchor must form and the panel show it
  await page.evaluate(`window.__app.setTerrain('flat'); window.__app.setPlatform('disc-rotate');`);
  const discId = await page.evaluate(`window.__app.registry()[0].id`);
  let discContacts = null;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(120);
    discContacts = await page.evaluate(`window.__app.contacts()`);
    if (discContacts.some((c) => c.anchorObj === discId)) break;
  }
  check('ui: disc object-local anchor forms',
    discContacts.some((c) => c.anchorObj === discId), JSON.stringify(discContacts.map((c) => c.anchorObj)));
  const anchored = discContacts.find((c) => c.anchorObj === discId);
  check('ui: anchor frame labelled with object id',
    anchored && anchored.frame === `object:${discId}`, anchored?.frame);
  const panelText = await page.textContent('#anchors');
  check('ui: anchor panel renders coordinate frame + failure reason columns',
    panelText.includes('锚点坐标系') && panelText.includes('失效原因') && panelText.includes('台面局部坐标'));

  // relative velocity stays low while riding the rotating disc (no false slip)
  let maxRel = 0;
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(100);
    const cs = await page.evaluate(`window.__app.contacts()`);
    for (const c of cs) if (c.anchorObj === discId) maxRel = Math.max(maxRel, c.relVel);
  }
  check('ui: disc-riding sole relative speed stays small', maxRel < 0.6, `maxRel=${maxRel.toFixed(3)}`);
  await page.screenshot({ path: path.join(root, 'test', 'shot-platform-disc.png') });

  // vanish: object-gone reason must be recorded and persist on the panel
  await page.evaluate(`window.__app.setPlatform('vanish');`);
  let vanishReason = null;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(120);
    const cs = await page.evaluate(`window.__app.contacts()`);
    if (cs.some((c) => c.objectReason === 'object-gone')) { vanishReason = 'object-gone'; break; }
  }
  check('ui: vanishing platform records object-gone reason', vanishReason === 'object-gone', String(vanishReason));
  const vanishPanel = await page.textContent('#anchors');
  check('ui: panel shows the object-gone explanation', vanishPanel.includes('台面已删除'));

  // recycle: same-name replacement gets a new generation, no inherited anchor
  await page.evaluate(`window.__app.setPlatform('recycle');`);
  await page.waitForTimeout(2500);
  const oldId = await page.evaluate(`window.__app.registry()[0].id`);
  const recycledIds = await page.evaluate(`window.__app.recyclePlatform('回收台面')`);
  const freshId = await page.evaluate(`window.__app.registry()[0].id`);
  check('ui: recycled same-name platform gets a fresh id',
    recycledIds.includes(oldId) && freshId !== oldId, `old=${oldId} fresh=${freshId}`);

  // seek: deterministic rebuild at the same time
  await page.evaluate(`window.__app.setPlatform('disc-rotate');`);
  await page.evaluate(`window.__app.seek(9.0)`);
  const snapA = await page.evaluate(`JSON.stringify(window.__app.contacts().map(c => [c.anchorObj, c.frame, c.plant]))`);
  await page.evaluate(`window.__app.seek(9.0)`);
  const snapB = await page.evaluate(`JSON.stringify(window.__app.contacts().map(c => [c.anchorObj, c.frame, c.plant]))`);
  check('ui: seek to same time rebuilds identical contact state', snapA === snapB);

  await browser.close();
  if (server) server.kill();
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error(e);
  if (browser) await browser.close();
  if (server) server.kill();
  process.exit(1);
}
