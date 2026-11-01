/* easyCube access administration, 2026-11-01. AGPL-3.0. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash, createCipheriv, createDecipheriv, pbkdf2 } = require('node:crypto');
const { promisify } = require('node:util');
const derive = promisify(pbkdf2);

function participant(account) {
  return ['participant', 'creator', 'guest'].includes(account?.role);
}
function rotatable(username, account) {
  return account?.room === 'production' &&
    (account.role === 'guest' || (['creator', 'participant'].includes(account.role) && /^Creator0[12]$/.test(username)));
}
function atomicJSON(filename, data) {
  const temporary = path.join(path.dirname(filename), '.' + path.basename(filename) + '.' + randomBytes(12).toString('hex'));
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(data));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor); descriptor = undefined;
    fs.renameSync(temporary, filename);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
class CredentialStore {
  constructor(baseFile, overrideFile, exportKeyFile) {
    this.baseFile = baseFile;
    this.overrideFile = overrideFile;
    this.exportKey = null;
    if (exportKeyFile) {
      try {
        const value = fs.readFileSync(exportKeyFile, 'utf8').trim();
        if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Invalid password-export key');
        this.exportKey = Buffer.from(value, 'hex');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.overrides = { version: 1, accounts: {} };
    try {
      this.overrides = JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
      if (this.overrides.version !== 1 || !this.overrides.accounts || typeof this.overrides.accounts !== 'object' || Array.isArray(this.overrides.accounts)) throw new Error('Invalid credential overrides');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  record(username) {
    const base = JSON.parse(fs.readFileSync(this.baseFile, 'utf8'));
    const item = this.overrides.accounts[username] || base.accounts?.[username];
    if (!item || !/^[0-9a-f]{32}$/.test(item.salt || '') || !/^[0-9a-f]{64}$/.test(item.hash || '') || item.iterations !== 310000) return null;
    return item;
  }
  fingerprint(username) {
    const record = this.record(username);
    return record ? createHash('sha256').update(record.salt + ':' + record.hash).digest('hex') : null;
  }
  encryptPassword(username, password, record) {
    if (!this.exportKey) throw new Error('Password-export encryption key is unavailable');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.exportKey, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify([username, record.salt, record.hash])));
    const encrypted = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
    return { version: 1, nonce: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ciphertext: encrypted.toString('hex') };
  }
  exportPassword(username) {
    const record = this.overrides.accounts[username];
    if (!record?.exportPassword) return null;
    const sealed = record.exportPassword;
    if (!this.exportKey || sealed.version !== 1 || !/^[0-9a-f]{24}$/.test(sealed.nonce || '') ||
        !/^[0-9a-f]{32}$/.test(sealed.tag || '') || !/^(?:[0-9a-f]{2}){1,256}$/.test(sealed.ciphertext || '')) throw new Error('Password export is unavailable');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.exportKey, Buffer.from(sealed.nonce, 'hex'));
      decipher.setAAD(Buffer.from(JSON.stringify([username, record.salt, record.hash])));
      decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));
      const password = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'hex')), decipher.final()]).toString('utf8');
      if (!password || /[\r\n\x00]/.test(password)) throw new Error('Invalid export value');
      return password;
    } catch { throw new Error('Password export could not be verified'); }
  }
  async rotate(usernames) {
    // Persist the hash and its encrypted export value in the same atomic record.
    if (!this.exportKey) throw new Error('Password-export encryption key is unavailable');
    const changes = await Promise.all(usernames.map(async username => {
      const password = randomBytes(18).toString('base64url');
      const salt = randomBytes(16);
      const hash = await derive(password, salt, 310000, 32, 'sha256');
      const record = { salt: salt.toString('hex'), hash: hash.toString('hex'), iterations: 310000, changedAt: new Date().toISOString() };
      record.exportPassword = this.encryptPassword(username, password, record);
      return { username, password, record };
    }));
    const next = { version: 1, accounts: { ...this.overrides.accounts } };
    for (const change of changes) next.accounts[change.username] = change.record;
    atomicJSON(this.overrideFile, next);
    this.overrides = next;
    return changes.map(({ username, password }) => ({ username, password }));
  }
}
class RateLimiter {
  constructor(rate, burst, maxKeys = 2048) { this.rate = rate; this.burst = burst; this.maxKeys = maxKeys; this.keys = new Map(); }
  take(key, cost = 1) {
    const now = Date.now();
    const prior = this.keys.get(key);
    const tokens = Math.min(this.burst, (prior?.tokens ?? this.burst) + (now - (prior?.time ?? now)) * this.rate / 1000);
    if (!prior && this.keys.size >= this.maxKeys) this.keys.delete(this.keys.keys().next().value);
    const allowed = tokens >= cost;
    this.keys.set(key, { tokens: allowed ? tokens - cost : tokens, time: now });
    return allowed;
  }
}
module.exports = { participant, rotatable, CredentialStore, RateLimiter, atomicJSON };
