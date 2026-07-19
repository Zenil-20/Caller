/* ==========================================================================
   Live regression test: the call screen must not cry wolf.

   Two real Chromium browsers sign in, place a real WebRTC call to each other
   through a running server, and then the exact handler the app installed is
   driven through the transitions a network blip produces. What the user
   actually reads (#peer-state) is observed throughout.

   This exists because the bug it covers was invisible to every cheaper kind of
   test: the code was correct in isolation, the call connected, the audio was
   fine, and the only symptom was a warning flashing on screen during a
   perfectly healthy call.

   Usage:
     GIANS_URL=https://your-host node tests/call-connection-state.test.js

   Requires Playwright (not a dependency of the app — it is only needed here):
     npm i -D playwright && npx playwright install chromium

   NOTE: this creates two accounts named zz_diagtest_* on the target server and
   deletes them again at the end. Point GIANS_URL at something you are happy to
   write to.
   ========================================================================== */
'use strict';

const BASE = process.env.GIANS_URL || 'http://localhost:4000';
const PASS = 'DiagTest!2026x';
const A = 'zz_diagtest_a';
const B = 'zz_diagtest_b';

/**
 * Playwright is deliberately not in package.json: the production image is
 * built with `npm ci --omit=dev`, and a browser download has no business
 * anywhere near it. Resolved leniently so a local or global install both work.
 */
function loadPlaywright() {
  const candidates = [
    'playwright',
    process.env.PLAYWRIGHT_PATH,
  ].filter(Boolean);

  for (const c of candidates) {
    try { return require(c); } catch { /* try the next */ }
  }
  console.error('Playwright not found. Install it, or set PLAYWRIGHT_PATH.');
  console.error('  npm i -D playwright && npx playwright install chromium');
  process.exit(3);
  return null;
}

const { chromium } = loadPlaywright();

let failures = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  -> ${detail}`}`);
  if (!cond) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = (path, body) => fetch(`${BASE}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

async function ensureAccount(username) {
  await api('/api/auth/register', { username, password: PASS, displayName: `Diag ${username}` });
  return api('/api/auth/login', { identifier: username, password: PASS });
}

async function openApp(browser, session) {
  const ctx = await browser.newContext({ permissions: ['microphone'] });
  const page = await ctx.newPage();

  await page.addInitScript((s) => {
    localStorage.setItem('gians.session', JSON.stringify(s));

    // Capture the handlers setupPeerConnection installs, so the real
    // production code path can be driven directly rather than reimplemented.
    // Wrapping before any app script runs is the only moment this is possible.
    const install = () => {
      if (!window.RTC || window.RTC.__wrapped) return;
      const original = window.RTC.configure;
      window.RTC.configure = function wrapped(handlers) {
        window.__captured = handlers;
        return original.call(this, handlers);
      };
      window.RTC.__wrapped = true;
    };
    const iv = setInterval(() => { install(); if (window.RTC?.__wrapped) clearInterval(iv); }, 10);

    // Record every change to the element the user actually reads.
    window.__peerStates = [];
    document.addEventListener('DOMContentLoaded', () => {
      const el = document.querySelector('#peer-state');
      if (!el) return;
      new MutationObserver(() => {
        window.__peerStates.push({ t: Date.now(), text: el.textContent || '' });
      }).observe(el, { childList: true, characterData: true, subtree: true });
    });
  }, { accessToken: session.accessToken, refreshToken: session.refreshToken, user: session.user });

  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Store?.state?.user, null, { timeout: 45000 });
  return page;
}

(async () => {
  console.log(`target: ${BASE}\n`);

  const [sa, sb] = await Promise.all([ensureAccount(A), ensureAccount(B)]);
  if (!sa.accessToken || !sb.accessToken) {
    console.error('could not sign in the test accounts', sa, sb);
    process.exit(3);
  }

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const pageA = await openApp(browser, sa);
  const pageB = await openApp(browser, sb);

  // Placed through the real dialler so the app's own placeCall runs: it builds
  // the peer connection and sends the offer. Emitting call:initiate directly
  // skips both, and the call never connects.
  await pageA.evaluate((username) => {
    document.querySelector('#dialer-display').value = username;
    document.querySelector('#btn-dial').click();
  }, B);

  await pageB.waitForFunction(() => window.Store?.state?.call?.status === 'ringing', null, { timeout: 30000 });
  await pageB.evaluate(() => document.querySelector('#btn-accept')?.click());

  const connected = await pageA.waitForFunction(
    () => window.Store?.state?.call?.status === 'active', null, { timeout: 45000 },
  ).then(() => true).catch(() => false);
  check('a real call connects end to end', connected, 'never reached active');
  if (!connected) { await browser.close(); process.exit(1); }

  // Wait for the connection to stop moving before driving synthetic states.
  // While it is still settling the browser emits real transitions of its own,
  // which overwrite the ones under test and make this disagree between runs.
  const settled = await pageA.waitForFunction(() => {
    const pc = window.RTC.getPeerConnection();
    return pc && pc.connectionState === 'connected' && pc.iceConnectionState === 'connected';
  }, null, { timeout: 30000 }).then(() => true).catch(() => false);
  check('peer connection settles before the experiment', settled, 'never reached steady state');
  await sleep(1500);

  const read = () => pageA.evaluate(() => document.querySelector('#peer-state')?.textContent || '');
  const drive = (s) => pageA.evaluate((v) => window.__captured.onConnectionStateChange(v), s);

  check('call screen is clean before any blip', (await read()) === '', 'already warning');

  // A short disconnect that recovers. iceConnectionState reports `disconnected`
  // whenever a few ICE consent checks go unanswered, and recovers by itself —
  // and DTX (silence suppression) makes that likelier during a quiet moment.
  await drive('disconnected');
  await sleep(600);
  const mid = await read();
  await sleep(600);
  await drive('connected');
  await sleep(300);
  check('a blip that recovers is never shown to the user',
    mid === '' && (await read()) === '', `showed "${mid}"`);

  // A disconnect that does NOT recover is a real problem and must be reported.
  await drive('disconnected');
  await sleep(3500);
  check('a sustained disconnect IS reported', /reconnect/i.test(await read()), 'stayed silent');
  await drive('connected');
  await sleep(300);
  check('the warning clears on recovery', (await read()) === '', 'still showing');

  // `failed` is terminal, not transient — never delay it.
  await drive('failed');
  await sleep(250);
  check('failed is reported immediately', /reconnect/i.test(await read()), 'nothing shown');
  await drive('connected');
  await sleep(300);

  // Repeated blips, as DTX produces during a quiet conversation. This is the
  // shape of the original bug: the warning flickered on and off all call.
  const before = await pageA.evaluate(() => window.__peerStates.length);
  for (let i = 0; i < 5; i += 1) {
    await drive('disconnected');
    await sleep(700);
    await drive('connected');
    await sleep(400);
  }
  await sleep(500);
  const flicker = await pageA.evaluate(
    (n) => window.__peerStates.slice(n).filter((s) => /reconnect/i.test(s.text)).length,
    before,
  );
  check('five recovering blips flash nothing at the user', flicker === 0, `flashed ${flicker} time(s)`);

  await pageA.evaluate(() => window.Signal.emit('call:end', {
    callId: window.Store.state.call?.callId, reason: 'test-complete',
  }));
  await browser.close();

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall passed');
  console.log(`\nRemember to remove the ${A} / ${B} accounts from the target server.`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
