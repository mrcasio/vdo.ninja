/* Modified by easyCube, 2026-09-24 through 2026-11-01. Distributed under AGPL-3.0. See MODIFICATIONS.md and AGPLv3.md. */
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { createHash, timingSafeEqual, randomBytes, pbkdf2 } = require('node:crypto');
const { promisify } = require('node:util');
const { participant, rotatable, CredentialStore, RateLimiter, atomicJSON } = require('./access-manager');
const path = require('node:path');
const { Navigation } = require('./navigation');
const { AccountDownloads } = require('./account-downloads');

const port = Number(process.env.PORT || 8080);
const ttlSeconds = 10800;
const cacheMilliseconds = 5 * 60 * 1000;
const allowedOrigin = process.env.ALLOWED_ORIGIN || 'https://video.easy-cube.de';
const configPath = process.env.TWILIO_CONFIG || '/run/secrets/twilio.json';
const hashesPath = process.env.TURN_KEY_HASHES || '/run/secrets/turn-key-hashes.json';
const accessPolicyPath = process.env.ACCESS_POLICY || '/run/secrets/access-policy.json';
const passwordHashesPath = process.env.PASSWORD_HASHES || '/run/secrets/auth-password-hashes.json';
const shortlinksPath = process.env.SHORTLINKS_FILE || '/run/secrets/shortlinks.json';
const obsViewersPath = process.env.OBS_VIEWERS_FILE || '/run/secrets/obs-viewers.json';
const sessionFile = process.env.SESSION_FILE || '/run/session-state/sessions.json';
const loginPagePath = process.env.LOGIN_PAGE || '/app/login.html';
const sessionLifetime = 24 * 60 * 60 * 1000;
const credentials = new CredentialStore(passwordHashesPath, process.env.CREDENTIAL_OVERRIDES || path.join(path.dirname(sessionFile), 'credentials.json'), process.env.PASSWORD_EXPORT_KEY_FILE || '/run/secrets/password-export.key');
const adminPagePath = process.env.ADMIN_PAGE || '/app/production-access.html';
const homePagePath = process.env.HOME_PAGE || '/app/home.html';
const authAttempts = new RateLimiter(10, 40);
let passwordChecks = 0;
let rotationBusy = false;
let lastLoginIssued = Date.now();
function policy() { return JSON.parse(fs.readFileSync(accessPolicyPath, 'utf8')); }
function isProductionAdmin(req) { return currentSession(req) === 'Production' && policy().accounts?.Production?.role === 'director'; }

const verifyPasswordHash = promisify(pbkdf2);
const cache = new Map();
const pending = new Map();
const retryAfter = new Map();
const basicCache = new Map();
const basicPending = new Map();
const loginFailures = new Map();
let sessions = {};
try {
  sessions = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) sessions = {};
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const shortlinks = JSON.parse(fs.readFileSync(shortlinksPath, 'utf8'));
if (shortlinks.version !== 1 || !shortlinks.links || typeof shortlinks.links !== 'object' ||
    Array.isArray(shortlinks.links)) throw new Error('Shortlink map is missing or invalid');
const obsViewers = JSON.parse(fs.readFileSync(obsViewersPath, 'utf8'));
if (obsViewers.version !== 1 || !obsViewers.links || typeof obsViewers.links !== 'object' ||
    Array.isArray(obsViewers.links)) throw new Error('OBS viewer map is missing or invalid');

const navigation = new Navigation({ origin: allowedOrigin, getPolicy: policy, links: shortlinks.links, viewers: obsViewers.links, allowEntry });
const accountDownloads = new AccountDownloads({ origin: allowedOrigin, getPolicy: policy, navigation, credentials,
  passwordFile: process.env.ACCOUNT_EXPORT_FILE || '/run/secrets/account-export.json' });

function obsViewer(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const item = obsViewers.links[token];
  if (!item || typeof item.participant !== 'string' || typeof item.path !== 'string') return null;
  try {
    const policy = JSON.parse(fs.readFileSync(accessPolicyPath, 'utf8'));
    const account = policy.accounts?.[item.participant];
    const room = policy.rooms?.[account?.room];
    if (!account || !['participant', 'creator', 'guest'].includes(account.role) ||
        !room || typeof account.pushStream !== 'string') return null;
    const target = new URL(item.path, allowedOrigin);
    if (target.origin !== allowedOrigin || target.pathname !== '/' ||
        [...target.searchParams.keys()].sort().join(',') !== 'obstoken,room,solo,view' ||
        target.searchParams.get('room') !== room.id ||
        target.searchParams.get('view') !== account.pushStream ||
        target.searchParams.get('solo') !== '' ||
        target.searchParams.get('obstoken') !== token ||
        !/^#\?turn=twilio&turnkey=[0-9a-f]{64}$/i.test(target.hash)) return null;
    return { participant: item.participant, room: account.room, path: item.path };
  } catch {
    return null;
  }
}

function obsIdentity(viewer) {
  return `obs-view:${viewer.participant}`;
}

function obsRequest(originalURI, obsToken) {
  try {
    if (typeof originalURI !== 'string' || !originalURI.startsWith('/')) return null;
    const target = new URL(originalURI, allowedOrigin);
    if (target.origin !== allowedOrigin) return null;
    if (['/', '/index', '/index.html'].includes(target.pathname)) {
      const token = target.searchParams.get('obstoken');
      const viewer = obsViewer(token);
      if (!viewer || target.pathname + target.search !== new URL(viewer.path, allowedOrigin).pathname +
          new URL(viewer.path, allowedOrigin).search) return null;
      return obsIdentity(viewer);
    }
    if (target.pathname === '/ws' && [...target.searchParams.keys()].join(',') === 'obstoken') {
      const viewer = obsViewer(target.searchParams.get('obstoken'));
      return viewer ? obsIdentity(viewer) : null;
    }
    if (target.pathname === '/api/turn' && !target.search && obsToken) {
      const viewer = obsViewer(obsToken);
      return viewer ? obsIdentity(viewer) : null;
    }
  } catch { /* Reject malformed URLs. */ }
  return null;
}

function obsAsset(originalURI) {
  try {
    const target = new URL(originalURI, allowedOrigin);
    return target.origin === allowedOrigin &&
      /\.(?:js|mjs|css|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf|wasm|mp3|wav)$/i.test(target.pathname);
  } catch { return false; }
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function readConfig() {
  try {
    const value = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!/^AC[0-9a-f]{32}$/i.test(value.accountSid || '') ||
        !/^SK[0-9a-f]{32}$/i.test(value.apiKeySid || '') ||
        typeof value.apiKeySecret !== 'string' || !value.apiKeySecret) return null;
    return value;
  } catch {
    return null;
  }
}

function allowedKey(key, username) {
  if (typeof key !== 'string' || !/^[0-9a-f]{64}$/i.test(key)) return null;
  if (typeof username !== 'string') return null;
  let hashes;
  try {
    const policy = JSON.parse(fs.readFileSync(accessPolicyPath, 'utf8'));
    if (username.startsWith('obs-view:')) {
      const participant = policy.accounts?.[username.slice('obs-view:'.length)];
      if (!participant || !['participant', 'creator', 'guest'].includes(participant.role)) return null;
      username = participant.room === 'production' ? 'OBS' :
        participant.room === 'test' ? 'TestOBS' :
        participant.room === 'staging' ? 'StagingOBS' : '';
      if (policy.accounts?.[username]?.role !== 'obs') return null;
    }
    if (!Object.hasOwn(policy.accounts, username)) return null;
    hashes = JSON.parse(fs.readFileSync(hashesPath, 'utf8')).keys;
  } catch {
    return null;
  }
  if (!Array.isArray(hashes)) return null;
  const digest = createHash('sha256').update(key, 'ascii').digest();
  for (const item of hashes) {
    if (!item || item.label !== username || typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(item.sha256)) continue;
    if (timingSafeEqual(digest, Buffer.from(item.sha256, 'hex'))) return item.sha256;
  }
  return null;
}

function allowEntry(username, originalURI) {
  if (typeof username !== 'string' || typeof originalURI !== 'string' ||
      !originalURI.startsWith('/') || originalURI.length > 2048) return false;
  let policy;
  let target;
  try {
    policy = JSON.parse(fs.readFileSync(accessPolicyPath, 'utf8'));
    target = new URL(originalURI, allowedOrigin);
  } catch {
    return false;
  }
  if (target.origin !== allowedOrigin || !['/', '/index', '/index.html'].includes(target.pathname)) return false;
  const account = policy.accounts?.[username];
  if (!account) return false;
  const fields = [...target.searchParams.keys()].sort().join(',');
  if (username === 'Production' && account.role === 'director') {
    if (!Array.isArray(account.rooms)) return false;
    if (fields === 'director,nopush,totalroombitrate') {
      return target.searchParams.get('nopush') === '' &&
        target.searchParams.get('totalroombitrate') === '3000' &&
        account.rooms.some(name => policy.rooms?.[name]?.id === target.searchParams.get('director'));
    }
    if (fields === 'audiogain,broadcast,label,miconly,push,room,totalroombitrate') {
      const talkRoom = account.rooms.map(name => policy.rooms?.[name]).find(item =>
        item?.id === target.searchParams.get('room'));
      return Boolean(talkRoom &&
        target.searchParams.get('miconly') === '' &&
        target.searchParams.get('audiogain') === '0' &&
        target.searchParams.get('totalroombitrate') === '3000' &&
        target.searchParams.get('label') === 'production-talk' &&
        target.searchParams.get('broadcast') === talkRoom.returnStream &&
        target.searchParams.get('push') === talkRoom.talkStream);
    }
    return false;
  }
  const room = policy.rooms?.[account.room];
  if (!room || typeof room.id !== 'string' || typeof room.returnStream !== 'string') return false;
  if (account.role === 'codirector') {
    return fields === 'autogain,denoise,director,echocancellation,maxframerate,noclaim,outboundvideobitrate,push,quality,roombitrate,totalroombitrate' &&
      target.searchParams.get('noclaim') === '' &&
      target.searchParams.get('autogain') === '0' &&
      target.searchParams.get('echocancellation') === '0' &&
      target.searchParams.get('denoise') === '0' &&
      target.searchParams.get('quality') === '0' &&
      target.searchParams.get('maxframerate') === '30' &&
      target.searchParams.get('outboundvideobitrate') === '3000' &&
      target.searchParams.get('roombitrate') === '3000' &&
      target.searchParams.get('totalroombitrate') === '3000' &&
      target.searchParams.get('director') === room.id &&
      target.searchParams.get('push') === room.returnStream &&
      account.pushStream === room.returnStream;
  }
  if (target.searchParams.get('room') !== room.id) return false;
  if (['guest', 'participant', 'creator'].includes(account.role)) {
    const joker = account.role === 'guest';
    return fields === (joker ? 'audiogain,broadcast,label,nomicbutton,push,room,totalroombitrate' :
      'audiogain,broadcast,label,push,room,totalroombitrate') &&
      target.searchParams.get('broadcast') === room.returnStream &&
      target.searchParams.get('audiogain') === '0' &&
      target.searchParams.get('totalroombitrate') === '3000' &&
      (!joker || target.searchParams.get('nomicbutton') === '') &&
      target.searchParams.get('label') === account.label &&
      target.searchParams.get('push') === account.pushStream;
  }
  if (account.role === 'obs') {
    if (fields !== 'room,solo,view' || target.searchParams.get('solo') !== '') return false;
    const view = target.searchParams.get('view');
    return Object.values(policy.accounts).some(item => item.room === account.room &&
      ['participant', 'creator', 'guest'].includes(item.role) && item.pushStream === view);
  }
  return false;
}

function entryPath(originalURI) {
  try {
    if (typeof originalURI !== 'string' || !originalURI.startsWith('/')) return null;
    const path = new URL(originalURI, allowedOrigin).pathname;
    return ['/', '/index', '/index.html'].includes(path);
  } catch {
    return null;
  }
}

function cookie(req, name) {
  const raw = req.headers.cookie;
  if (typeof raw !== 'string') return '';
  for (const part of raw.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return '';
}

function tokenHash(token) {
  return createHash('sha256').update(token, 'ascii').digest('hex');
}

function sessionValid(hash, record) {
  if (!record || record.expires <= Date.now() || !policy().accounts?.[record.username]) return false;
  const fingerprint = credentials.fingerprint(record.username);
  return Boolean(fingerprint && (record.credentialVersion ? record.credentialVersion === fingerprint : !credentials.overrides.accounts[record.username]));
}
function sessionInfo(req) {
  const token = cookie(req, '__Host-vdo_session');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const hash = tokenHash(token);
  const record = sessions[hash];
  return sessionValid(hash, record) ? { hash, username: record.username } : null;
}
function currentSession(req) { return sessionInfo(req)?.username || null; }
function saveSessions() {
  for (const [key, value] of Object.entries(sessions)) {
    if (!sessionValid(key, value)) delete sessions[key];
  }
  atomicJSON(sessionFile, sessions);
}
// Existing credentials remain valid. Keep only the most recent participant login.
{
  const newest = new Map();
  const accounts = policy().accounts;
  for (const [hash, record] of Object.entries(sessions)) {
    if (!sessionValid(hash, record)) { delete sessions[hash]; continue; }
    if (!participant(accounts[record.username])) continue;
    const previous = newest.get(record.username);
    if (previous && sessions[previous].expires > record.expires) delete sessions[hash];
    else { if (previous) delete sessions[previous]; newest.set(record.username, hash); }
  }
  saveSessions();
}

async function validPassword(username, password) {
  if (typeof username !== 'string' || typeof password !== 'string' || username.length > 64 || password.length > 256) return false;
  const item = credentials.record(username);
  if (!item || passwordChecks >= 32) return false;
  const fingerprint = credentials.fingerprint(username);
  passwordChecks++;
  try {
    const digest = await verifyPasswordHash(password, Buffer.from(item.salt, 'hex'), item.iterations, 32, 'sha256');
    return timingSafeEqual(digest, Buffer.from(item.hash, 'hex')) && credentials.fingerprint(username) === fingerprint;
  } finally { passwordChecks--; }
}

async function basicUser(authorization, source) {
  if (typeof authorization !== 'string' || authorization.length > 4096 ||
      !/^Basic [A-Za-z0-9+/=]+$/.test(authorization)) return null;
  const key = tokenHash(authorization);
  const cached = basicCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.username;
  if (basicPending.has(key)) return basicPending.get(key);
  if (!authAttempts.take(source)) return null;
  const verification = (async () => {
    let username = null;
    try {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const colon = decoded.indexOf(':');
      if (colon > 0 && !participant(policy().accounts?.[decoded.slice(0, colon)]) && await validPassword(decoded.slice(0, colon), decoded.slice(colon + 1))) {
        username = decoded.slice(0, colon);
      }
    } catch {
      username = null;
    }
    basicCache.set(key, { username, expires: Date.now() + (username ? 60000 : 2000) });
    if (basicCache.size > 128) basicCache.delete(basicCache.keys().next().value);
    return username;
  })();
  basicPending.set(key, verification);
  try {
    return await verification;
  } finally {
    basicPending.delete(key);
  }
}

function authReply(res, status, username, sessionHash) {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (username) headers['X-Authenticated-User'] = username;
  if (sessionHash) headers['X-Authenticated-Session'] = sessionHash;
  res.writeHead(status, headers);
  res.end();
}

function sessionCookie(token) {
  return `__Host-vdo_session=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${sessionLifetime / 1000}`;
}

function validAction(req, action) {
  return req.headers.origin === allowedOrigin && req.headers['x-vdo-action'] === action;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      if (raw.length > 2048) return;
      raw += chunk;
      if (raw.length > 2048) reject(new Error('Request too large'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function requestToken(config) {
  return new Promise((resolve, reject) => {
    const body = `Ttl=${ttlSeconds}`;
    const request = https.request({
      hostname: 'api.twilio.com',
      port: 443,
      path: `/2010-04-01/Accounts/${config.accountSid}/Tokens.json`,
      method: 'POST',
      auth: `${config.apiKeySid}:${config.apiKeySecret}`,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 8000,
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        raw += chunk;
        if (raw.length > 65536) response.destroy(new Error('Twilio response too large'));
      });
      response.on('end', () => {
        if (response.statusCode !== 201 && response.statusCode !== 200) {
          reject(new Error(`Twilio HTTP ${response.statusCode}`));
          return;
        }
        try {
          const result = JSON.parse(raw);
          if (!Array.isArray(result.ice_servers) ||
              !result.ice_servers.some(item => String(item.urls || '').startsWith('turn:'))) {
            throw new Error('Twilio returned no TURN server');
          }
          resolve({ ice_servers: result.ice_servers, ttl: ttlSeconds });
        } catch (error) {
          reject(error);
        }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Twilio timeout')));
    request.on('error', reject);
    request.end(body);
  });
}


async function productionAccess(req, res) {
  if (!isProductionAdmin(req)) return send(res, 403, { error: 'Production login required' });
  const accounts = policy().accounts;
  const download = /^\/api\/production-access\/export\/(test|staging|production)$/.exec(req.url);
  if (download) {
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
    if (!validAction(req, 'download-access-list')) return send(res, 403, { error: 'Forbidden' });
    const result = accountDownloads.render(download[1]);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + result.filename + '"',
      'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    return res.end(result.text);
  }
  if (req.url === '/production-access' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    return res.end(fs.readFileSync(adminPagePath));
  }
  if (req.url === '/api/production-access' && req.method === 'GET') {
    return send(res, 200, { accounts: Object.entries(accounts).filter(([name, account]) => rotatable(name, account)).map(([username, account]) => ({
      username, label: account.label || username,
      changedAt: credentials.overrides.accounts[username]?.changedAt || null,
    })) });
  }
  const renewLegacy = req.url === '/api/production-access/renew-legacy';
  if ((!renewLegacy && req.url !== '/api/production-access/rotate') || req.method !== 'POST') return send(res, 404, { error: 'Not found' });
  if (!validAction(req, renewLegacy ? 'renew-legacy-exports' : 'rotate-production-access') || req.headers['content-type'] !== 'application/json') return send(res, 403, { error: 'Forbidden' });
  if (rotationBusy) return send(res, 409, { error: 'Eine Änderung läuft bereits.' });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'Invalid request' }); }
  if (rotationBusy) return send(res, 409, { error: 'Eine Änderung läuft bereits.' });
  if (renewLegacy) {
    if (!body || Object.keys(body).join(',') !== 'confirm' || body.confirm !== 'RENEW_LEGACY_EXPORTS') return send(res, 400, { error: 'Explicit legacy renewal confirmation required' });
    const usernames = Object.entries(credentials.overrides.accounts).filter(([name, record]) => rotatable(name, accounts[name]) && !record.exportPassword).map(([name]) => name);
    if (!usernames.length) return send(res, 200, { credentials: [], message: 'Alle erneuerten Passwörter sind bereits exportierbar.' });
    body = { confirm: 'ROTATE_PRODUCTION', usernames };
  }
  if (!body || Object.keys(body).sort().join(',') !== 'confirm,usernames' || body.confirm !== 'ROTATE_PRODUCTION' ||
      !Array.isArray(body.usernames) || body.usernames.length < 1 || body.usernames.length > 14 ||
      new Set(body.usernames).size !== body.usernames.length ||
      !body.usernames.every(name => typeof name === 'string' && Object.hasOwn(accounts, name) && rotatable(name, accounts[name]))) {
    return send(res, 400, { error: 'Nur Production-Joker und -Creator können hier geändert werden.' });
  }
  rotationBusy = true;
  try {
    const changed = await credentials.rotate(body.usernames);
    for (const [hash, record] of Object.entries(sessions)) if (body.usernames.includes(record.username)) delete sessions[hash];
    basicCache.clear();
    try { saveSessions(); } catch (error) { console.error('Session persistence after rotation failed:', error.name); }
    for (const item of changed) {
      const invite = Object.entries(shortlinks.links).find(([, link]) => link.username === item.username);
      item.link = invite ? allowedOrigin + '/l/' + invite[0] : null;
    }
    return send(res, 200, { credentials: changed, message: 'Passwörter erneuert. Alte Sitzungen werden getrennt. Die aktuellen Passwörter können jederzeit über die vollständige Production-Liste exportiert werden.' });
  } finally { rotationBusy = false; }
}

function serveLogin(res) {
  const page = fs.readFileSync(loginPagePath);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  return res.end(page);
}
function redirectTo(res, target) {
  const url = new URL(target, allowedOrigin);
  if (!target.startsWith('/') || target.startsWith('//') || url.origin !== allowedOrigin || /[\r\n]/.test(target)) throw new Error('Unsafe navigation target');
  res.writeHead(302, { Location: target, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  res.end();
}
function accountNavigation(req, res) {
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' });
  const username = currentSession(req);
  if (!username) return req.url === '/home' || req.url.startsWith('/launch/') ? serveLogin(res) : send(res, 401, { error: 'Login required' });
  if (req.url.startsWith('/launch/')) {
    const route = /^\/launch\/director\/(test|staging|production)$/.exec(req.url);
    if (!route) return send(res, 404, { error: 'Not found' });
    const target = navigation.director(username, route[1]);
    return target ? redirectTo(res, target) : send(res, 403, { error: 'This account cannot open that Director page.' });
  }
  const info = navigation.home(username);
  if (req.url === '/api/navigation') return send(res, 200, info);
  if (info.default !== '/home') return redirectTo(res, info.default);
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(fs.readFileSync(homePagePath));
}

async function handleRequest(req, res) {
  if (req.url === '/home' || req.url === '/api/navigation' || req.url?.startsWith('/launch/')) return accountNavigation(req, res);
  if (req.url === '/health' && req.method === 'GET') return send(res, 200, { ok: true });
  if (req.url === '/internal/active-sessions' && req.method === 'GET') {
    const active = {};
    for (const [hash, record] of Object.entries(sessions)) {
      if (sessionValid(hash, record)) active[hash] = { username: record.username, expires: record.expires, issuedAt: record.createdAt || record.expires - sessionLifetime };
    }
    return send(res, 200, { sessions: active });
  }
  if (req.url === '/production-access' || req.url?.startsWith('/api/production-access')) {
    return productionAccess(req, res);
  }
  const obsLink = /^\/obs\/([A-Za-z0-9_-]{32})$/.exec(req.url || '');
  if (obsLink) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Use GET' });
    const viewer = obsViewer(obsLink[1]);
    if (!viewer) return send(res, 404, { error: 'Not found' });
    res.writeHead(302, {
      Location: viewer.path,
      'Set-Cookie': `__Host-vdo_obs_assets=${obsLink[1]}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=7776000`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    });
    return res.end();
  }
  const shortlink = /^\/l\/([A-Za-z0-9_-]{22})$/.exec(req.url || '');
  if (shortlink) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Use GET' });
    try {
      const entry = shortlinks.links[shortlink[1]];
      if (!entry || typeof entry.username !== 'string' || typeof entry.path !== 'string' ||
          entry.path.length > 2048 || !entry.path.startsWith('/?') ||
          !allowEntry(entry.username, entry.path)) return send(res, 404, { error: 'Not found' });
      const target = new URL(entry.path, allowedOrigin);
      const policy = JSON.parse(fs.readFileSync(accessPolicyPath, 'utf8'));
      const isRoomPublisher = policy.accounts?.[entry.username]?.role === 'codirector';
      const fragmentValid = isRoomPublisher
        ? /^#\?codirector=[A-Za-z0-9]{28}&turn=twilio&turnkey=[0-9a-f]{64}$/i.test(target.hash)
        : /^#\?turn=twilio&turnkey=[0-9a-f]{64}$/i.test(target.hash);
      if (target.origin !== allowedOrigin || target.pathname !== '/' || !fragmentValid) {
        return send(res, 404, { error: 'Not found' });
      }
      res.writeHead(302, {
        Location: entry.path,
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end();
    } catch (error) {
      console.error(`Shortlink lookup failed: ${error.message}`);
      return send(res, 503, { error: 'Shortlink unavailable' });
    }
  }
  if (req.url === '/ready' && req.method === 'GET') {
    const ready = Boolean(readConfig());
    return send(res, ready ? 200 : 503, { ready });
  }
  if (req.url === '/internal/authorize-entry' && req.method === 'GET') {
    if (!allowEntry(req.headers['x-authenticated-user'], req.headers['x-original-uri'])) {
      return send(res, 403, { error: 'Forbidden' });
    }
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    return res.end();
  }
  if (req.url === '/internal/authenticate' && req.method === 'GET') {
    try {
      const originalURI = req.headers['x-original-uri'];
      const target = new URL(originalURI, allowedOrigin);
      if (target.searchParams.has('obstoken') || req.headers['x-obs-token']) {
        const viewer = obsRequest(originalURI, req.headers['x-obs-token']);
        return viewer ? authReply(res, 204, viewer) : authReply(res, 403);
      }
      const identity = sessionInfo(req);
      const username = identity?.username ||
        (cookie(req, '__Host-vdo_logged_out') === '1' ? null : await basicUser(req.headers.authorization, String(req.headers['x-real-ip'] || req.socket.remoteAddress)));
      if (!username) {
        if (obsAsset(originalURI) && obsViewer(cookie(req, '__Host-vdo_obs_assets'))) {
          return authReply(res, 204);
        }
        return authReply(res, 401);
      }
      const checkEntry = entryPath(req.headers['x-original-uri']);
      if (checkEntry === null || (checkEntry && !allowEntry(username, req.headers['x-original-uri']))) {
        return authReply(res, 403);
      }
      return authReply(res, 204, username, identity?.hash);
    } catch (error) {
      console.error(`Access check failed: ${error.message}`);
      return authReply(res, 503);
    }
  }
  if (req.url === '/api/me' && req.method === 'GET') {
    const username = req.headers['x-authenticated-user'];
    try {
      const policy = JSON.parse(fs.readFileSync(accessPolicyPath, 'utf8'));
      if (typeof username !== 'string' || !Object.hasOwn(policy.accounts, username)) {
        return send(res, 403, { error: 'Forbidden' });
      }
      return send(res, 200, { username, canManageProductionAccess: username === 'Production' && policy.accounts?.Production?.role === 'director' });
    } catch {
      return send(res, 503, { error: 'Account unavailable' });
    }
  }
  if ((req.url === '/internal/login-page' || req.url === '/login') && req.method === 'GET') {
    try {
      return serveLogin(res);
    } catch {
      return send(res, 503, { error: 'Login unavailable' });
    }
  }
  if (req.url === '/login' && req.method === 'POST') {
    if (!validAction(req, 'login')) return send(res, 403, { error: 'Forbidden' });
    if (!String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) {
      return send(res, 415, { error: 'Use form data' });
    }
    let params;
    try {
      params = new URLSearchParams(await readBody(req));
    } catch {
      return send(res, 413, { error: 'Request too large' });
    }
    const username = params.get('username');
    const password = params.get('password');
    if (params.size !== 2 || !username || !password) return send(res, 400, { error: 'Missing credentials' });
    const source = String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown');
    if (!authAttempts.take(source)) return send(res, 429, { error: 'Please wait before retrying' });
    const failKey = `${source}:${username}`;
    const failures = loginFailures.get(failKey);
    if (failures && failures.count >= 10 && failures.until > Date.now()) {
      return send(res, 429, { error: 'Please wait before retrying' });
    }
    if (!await validPassword(username, password)) {
      const count = failures && failures.until > Date.now() ? failures.count + 1 : 1;
      loginFailures.set(failKey, { count, until: Date.now() + 10 * 60 * 1000 });
      if (loginFailures.size > 1024) loginFailures.delete(loginFailures.keys().next().value);
      return send(res, 401, { error: 'Invalid credentials' });
    }
    loginFailures.delete(failKey);
    const token = randomBytes(32).toString('base64url');
    if (participant(policy().accounts?.[username])) {
      for (const [hash, record] of Object.entries(sessions)) if (record.username === username) delete sessions[hash];
    }
    lastLoginIssued = Math.max(Date.now(), lastLoginIssued + 1);
    sessions[tokenHash(token)] = { username, createdAt: lastLoginIssued, credentialVersion: credentials.fingerprint(username), expires: lastLoginIssued + sessionLifetime };
    try {
      saveSessions();
    } catch (error) {
      delete sessions[tokenHash(token)];
      console.error(`Saving login session failed: ${error.message}`);
      return send(res, 503, { error: 'Login unavailable' });
    }
    res.writeHead(204, { 'Cache-Control': 'no-store', 'Set-Cookie': sessionCookie(token) });
    return res.end();
  }
  if (req.url === '/logout' && req.method === 'POST') {
    if (!validAction(req, 'logout')) return send(res, 403, { error: 'Forbidden' });
    const token = cookie(req, '__Host-vdo_session');
    if (/^[A-Za-z0-9_-]{43}$/.test(token)) {
      delete sessions[tokenHash(token)];
      try {
        saveSessions();
      } catch (error) {
        console.error(`Saving logout session failed: ${error.message}`);
        return send(res, 503, { error: 'Logout unavailable' });
      }
    }
    res.writeHead(204, {
      'Cache-Control': 'no-store',
      'Set-Cookie': [
        '__Host-vdo_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
        '__Host-vdo_logged_out=1; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000',
      ],
    });
    return res.end();
  }
  if (req.url !== '/api/turn') return send(res, 404, { error: 'Not found' });
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  if (req.headers.origin !== allowedOrigin) return send(res, 403, { error: 'Forbidden' });
  const keyHash = allowedKey(req.headers['x-turn-key'], req.headers['x-authenticated-user']);
  if (!keyHash) return send(res, 403, { error: 'Forbidden' });
  const config = readConfig();
  if (!config) return send(res, 503, { error: 'TURN unavailable' });
  const cached = cache.get(keyHash);
  if (cached && cached.expires > Date.now()) return send(res, 200, cached.value);
  if ((retryAfter.get(keyHash) || 0) > Date.now()) return send(res, 429, { error: 'Try again shortly' });
  try {
    if (!pending.has(keyHash)) pending.set(keyHash, requestToken(config));
    const value = await pending.get(keyHash);
    cache.set(keyHash, { value, expires: Date.now() + cacheMilliseconds });
    send(res, 200, value);
  } catch (error) {
    console.error(`TURN token request failed: ${error.message}`);
    retryAfter.set(keyHash, Date.now() + 30000);
    send(res, 502, { error: 'TURN unavailable' });
  } finally {
    pending.delete(keyHash);
  }
}
http.createServer((req, res) => {
  handleRequest(req, res).catch(error => {
    console.error('Request failed:', error.name);
    if (!res.headersSent) send(res, 503, { error: 'Service unavailable' });
    else res.destroy();
  });
}).listen(port, process.env.BIND_HOST || '0.0.0.0', () => console.log(`TURN broker listening on ${port}`));
