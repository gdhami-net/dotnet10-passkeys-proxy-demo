// Runs the template app (and the YARP proxy) in each configuration the post
// talks about, registers and uses passkeys with a Chromium virtual
// authenticator, and asserts what happens.
//
//   npm install && npx playwright install chromium && npm run check
//
// Ports: the app on 5292, the proxy on 5100. Nothing else may hold them.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'src', 'PasskeyApp');
const proxyDir = path.join(root, 'src', 'Proxy');
const appDll = path.join(appDir, 'bin', 'Debug', 'net10.0', 'PasskeyApp.dll');
const proxyDll = path.join(proxyDir, 'bin', 'Debug', 'net10.0', 'Proxy.dll');

const DIRECT = 'http://localhost:5292';
const PROXIED = 'http://app.localhost:5100';
const NESTED = 'http://login.app.localhost:5100';
const PASSWORD = 'Passw0rd!Passw0rd!';

const work = mkdtempSync(path.join(tmpdir(), 'passkeys-proxy-check-'));
const procs = new Set();
let browser;
let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
  if (!ok) failures++;
}

function start(dll, cwd, env, logs) {
  const p = spawn('dotnet', [dll], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.add(p);
  const take = (b) => { for (const l of b.toString().split(/\r?\n/)) if (l.trim()) logs.push(l); };
  p.stdout.on('data', take);
  p.stderr.on('data', take);
  p.on('exit', () => procs.delete(p));
  return p;
}

async function stop(p) {
  if (!p || p.exitCode !== null) return;
  const done = new Promise((r) => p.once('exit', r));
  p.kill();
  await done;
}

async function waitFor(url) {
  for (let i = 0; i < 120; i++) {
    try { await fetch(url); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error(`nothing answered on ${url}`);
}

// One app process. `config` is a set of .NET configuration keys.
async function startApp(db, config = {}) {
  const logs = [];
  const env = {
    ASPNETCORE_ENVIRONMENT: 'Development',
    ASPNETCORE_URLS: 'http://localhost:5292',
    ConnectionStrings__DefaultConnection: `DataSource=${path.join(work, db)}`,
  };
  for (const [k, v] of Object.entries(config)) env[k.replaceAll(':', '__')] = v;
  const p = start(appDll, appDir, env, logs);
  await waitFor(DIRECT + '/');
  return { p, logs };
}

async function startProxy() {
  const logs = [];
  const p = start(proxyDll, proxyDir, { ASPNETCORE_ENVIRONMENT: 'Production' }, logs);
  await waitFor('http://localhost:5100/');
  return { p, logs };
}

// A fresh page with its own virtual authenticator: internal transport,
// resident keys and user verification, so it behaves like a platform passkey.
async function newPage() {
  const context = await browser.newContext();
  // The login page also starts a conditional (autofill) passkey request on load,
  // and the virtual authenticator answers it on its own. Turn that off so every
  // sign-in goes through the "Log in with a passkey" button.
  await context.addInitScript(() => {
    if (window.PublicKeyCredential) PublicKeyCredential.isConditionalMediationAvailable = async () => false;
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    },
  });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  const redirects = [];
  page.on('response', (r) => { if (r.status() >= 300 && r.status() < 400) redirects.push(r.headers()['location'] ?? ''); });
  return { context, page, cdp, authenticatorId, consoleErrors, redirects };
}

async function statusText(page) {
  const alert = page.locator('.alert');
  return (await alert.count()) ? (await alert.first().innerText()).trim() : '';
}

async function registerAndLogIn(page, base, email) {
  await page.goto(base + '/Account/Register');
  await page.fill('[id="Input.Email"]', email);
  await page.fill('[id="Input.Password"]', PASSWORD);
  await page.fill('[id="Input.ConfirmPassword"]', PASSWORD);
  await page.click('button:has-text("Register")');
  await page.waitForURL(/RegisterConfirmation/);
  await page.click('text=Click here to confirm your account');
  await page.waitForURL(/ConfirmEmail/);
  await page.goto(base + '/Account/Login');
  await page.fill('[id="Input.Email"]', email);
  await page.fill('[id="Input.Password"]', PASSWORD);
  await page.click('button:has-text("Log in"):not(:has-text("passkey"))');
  await page.waitForURL((u) => !u.pathname.includes('/Account/Login'));
}

// Clicks the button and waits for the form post the template's script makes,
// then for the page it lands on. Returns that URL.
async function clickAndLand(page, selector) {
  const nav = page.waitForEvent('framenavigated', { timeout: 30000 });
  await page.click(selector);
  await nav;
  await page.waitForLoadState('load');
  return page.url();
}

// Adds a passkey on the Manage page. `stored` counts the passkeys the app shows
// for the account afterwards, read again through `base`.
async function addPasskey(page, base) {
  await page.goto(base + '/Account/Manage/Passkeys');
  const landed = await clickAndLand(page, 'button:has-text("Add a new passkey")');
  const status = await statusText(page);
  await page.goto(base + '/Account/Manage/Passkeys');
  const stored = await page.locator('button[value="delete"]').count();
  return { landed, status, stored };
}

// Drops the cookies, signs in with the passkey only, then asks for a page that
// needs a signed-in user through `base`.
async function signInWithPasskey(page, base, email) {
  await page.context().clearCookies();
  await page.goto(base + '/Account/Login');
  await page.fill('[id="Input.Email"]', email);
  const landed = await clickAndLand(page, 'button:has-text("Log in with a passkey")');
  const status = await statusText(page);
  await page.goto(base + '/Account/Manage');
  const signedIn = !new URL(page.url()).pathname.startsWith('/Account/Login');
  return { landed, status, signedIn };
}

async function rpIds(cdp, authenticatorId) {
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  return credentials.map((c) => c.rpId).join(',');
}

function serverLine(logs) {
  const l = logs.find((x) => x.includes('Passkey options'));
  return l ? '      server: ' + l.trim() : '      server: (no passkey call logged)';
}

function host(url) { return new URL(url).host; }

async function main() {
  if (!existsSync(appDll) || !existsSync(proxyDll)) throw new Error('build first: dotnet build PasskeysProxyDemo.slnx');
  browser = await chromium.launch();

  // 1. Direct, template defaults.
  {
    const app = await startApp('direct.db');
    const t = await newPage();
    await registerAndLogIn(t.page, DIRECT, 'direct@example.com');
    const add = await addPasskey(t.page, DIRECT);
    check('direct: the template registers a passkey', add.stored === 1, add.status);
    check('direct: the authenticator holds it for rpId "localhost"', (await rpIds(t.cdp, t.authenticatorId)) === 'localhost');
    const signIn = await signInWithPasskey(t.page, DIRECT, 'direct@example.com');
    check('direct: signing in with that passkey works', signIn.signedIn, signIn.status);
    console.log(serverLine(app.logs));
    await t.context.close();
    await stop(app.p);
  }

  const proxy = await startProxy();

  // 2. Behind the proxy, template defaults.
  {
    const app = await startApp('proxied.db');
    const t = await newPage();
    await registerAndLogIn(t.page, PROXIED, 'proxied@example.com');
    const add = await addPasskey(t.page, PROXIED);
    check('proxy, no fix: the app stores no passkey', add.stored === 0);
    check('proxy, no fix: the authenticator made none', (await rpIds(t.cdp, t.authenticatorId)) === '');
    const err = t.consoleErrors.find((e) => e.startsWith('SecurityError')) ?? '';
    check('proxy, no fix: the browser refuses the relying party ID', err.includes('relying party ID is not a registrable domain suffix'), 'browser console: ' + err);
    check("proxy, no fix: the app saw the proxy's upstream host, not app.localhost", /Request\.Host=127\.0\.0\.1:5292, ServerDomain=\(null\)/.test(serverLine(app.logs)));
    console.log(serverLine(app.logs));
    if (process.env.SHOW_APP_LOG) for (const l of app.logs) console.log('      app log: ' + l);
    check('proxy, no fix: the error redirect leaves the proxy for the internal host', host(add.landed) === '127.0.0.1:5292', 'landed on ' + add.landed);
    await t.context.close();
    await stop(app.p);
  }

  // 3. Behind the proxy, ServerDomain set and nothing else.
  {
    const app = await startApp('serverdomain.db', { 'Passkeys:ServerDomain': 'app.localhost' });
    const t = await newPage();
    await registerAndLogIn(t.page, PROXIED, 'fixed@example.com');
    const add = await addPasskey(t.page, PROXIED);
    check('proxy, ServerDomain only: the passkey is created and stored', add.stored === 1 && (await rpIds(t.cdp, t.authenticatorId)) === 'app.localhost');
    check('proxy, ServerDomain only: but the redirect after it still lands on the internal host', host(add.landed) === '127.0.0.1:5292', 'landed on ' + add.landed);
    console.log('      Location: ' + (t.redirects.find((l) => l.includes('RenamePasskey')) ?? '(none)'));
    const signIn = await signInWithPasskey(t.page, PROXIED, 'fixed@example.com');
    check('proxy, ServerDomain only: passkey sign-in works', signIn.signedIn, signIn.status);
    console.log(serverLine(app.logs));
    await t.context.close();
    await stop(app.p);
  }

  // 4. Behind the proxy, forwarded headers and no ServerDomain.
  {
    const app = await startApp('forwarded.db', { 'Proxy:UseForwardedHeaders': 'true', 'Proxy:AllowedHosts:0': 'app.localhost' });
    const t = await newPage();
    await registerAndLogIn(t.page, PROXIED, 'forwarded@example.com');
    const add = await addPasskey(t.page, PROXIED);
    check('proxy, forwarded headers only: registration works and stays on app.localhost', add.stored === 1 && host(add.landed) === 'app.localhost:5100', 'landed on ' + add.landed);
    const signIn = await signInWithPasskey(t.page, PROXIED, 'forwarded@example.com');
    check('proxy, forwarded headers only: sign-in works', signIn.signedIn, signIn.status);
    console.log(serverLine(app.logs));
    await t.context.close();
    await stop(app.p);
  }

  // 5. Both, then the value changes after a passkey exists. The page is on
  //    login.app.localhost, so both "login.app.localhost" and its parent
  //    "app.localhost" are IDs the browser accepts there.
  {
    const both = { 'Proxy:UseForwardedHeaders': 'true', 'Proxy:AllowedHosts:0': '*.app.localhost' };
    let app = await startApp('changed.db', { ...both, 'Passkeys:ServerDomain': 'login.app.localhost' });
    const t = await newPage();
    await registerAndLogIn(t.page, NESTED, 'moved@example.com');
    const add = await addPasskey(t.page, NESTED);
    check('both, ServerDomain=login.app.localhost: registration works', add.stored === 1 && host(add.landed) === 'login.app.localhost:5100', add.status);
    const before = await signInWithPasskey(t.page, NESTED, 'moved@example.com');
    check('both, ServerDomain=login.app.localhost: sign-in works', before.signedIn, before.status);
    await stop(app.p);

    app = await startApp('changed.db', { ...both, 'Passkeys:ServerDomain': 'app.localhost' });
    const after = await signInWithPasskey(t.page, NESTED, 'moved@example.com');
    check('changed to ServerDomain=app.localhost: the same passkey no longer signs in', !after.signedIn, 'page: ' + after.status);
    for (const e of t.consoleErrors) console.log('      browser console: ' + e);
    check('changed: the authenticator still holds it, under the old ID', (await rpIds(t.cdp, t.authenticatorId)) === 'login.app.localhost');
    await t.context.close();
    await stop(app.p);
  }

  await stop(proxy.p);
}

try {
  await main();
} catch (e) {
  failures++;
  console.error('ERROR ' + (e.stack || e));
} finally {
  if (browser) await browser.close().catch(() => {});
  for (const p of procs) await stop(p);
  rmSync(work, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
