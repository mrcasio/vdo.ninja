/* Encryption, migration and atomic persistence checks using synthetic secrets. AGPL-3.0. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { CredentialStore } = require('../turn-broker/access-manager');
async function testCredentialExport(baseFile) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-export-'));
  try {
    const keyFile = tmp + '/key';fs.writeFileSync(keyFile, randomBytes(32).toString('hex'));
    const target = tmp + '/credentials.json';
    const noKey = new CredentialStore(baseFile, target, tmp + '/absent-key');
    const fingerprint = noKey.fingerprint('Creator01');
    await assert.rejects(noKey.rotate(['Creator01']), /key is unavailable/);
    assert.equal(noKey.fingerprint('Creator01'), fingerprint);assert.ok(!fs.existsSync(target));
    const store = new CredentialStore(baseFile, target, keyFile);
    const changed = await store.rotate(['Creator01', 'Creator02']);
    const raw = fs.readFileSync(target, 'utf8');
    for (const item of changed) {assert.ok(!raw.includes(item.password));assert.equal(store.exportPassword(item.username),item.password);}
    const reloaded = new CredentialStore(baseFile, target, keyFile);
    assert.equal(reloaded.exportPassword('Creator01'),changed[0].password);
    // The authentication tag binds the account and its exact credential record.
    reloaded.overrides.accounts.Creator01.exportPassword = reloaded.overrides.accounts.Creator02.exportPassword;
    assert.throws(()=>reloaded.exportPassword('Creator01'),/could not be verified/);
    const altered = new CredentialStore(baseFile, target, keyFile);
    altered.overrides.accounts.Creator01.exportPassword.tag = '0'.repeat(32);
    assert.throws(()=>altered.exportPassword('Creator01'),/could not be verified/);
    fs.writeFileSync(tmp+'/wrong-key',randomBytes(32).toString('hex'));
    assert.throws(()=>new CredentialStore(baseFile,target,tmp+'/wrong-key').exportPassword('Creator01'),/could not be verified/);
    assert.throws(()=>new CredentialStore(baseFile,target,tmp+'/absent-key').exportPassword('Creator01'),/unavailable/);
    const legacy = JSON.parse(raw);delete legacy.accounts.Creator01.exportPassword;
    fs.writeFileSync(tmp+'/legacy.json',JSON.stringify(legacy));
    const migrated = new CredentialStore(baseFile,tmp+'/legacy.json',keyFile);
    assert.equal(migrated.exportPassword('Creator01'),null);
    assert.equal(migrated.fingerprint('Creator01'),store.fingerprint('Creator01'));
    const failed = new CredentialStore(baseFile,tmp+'/missing-directory/credentials.json',keyFile);
    const before = failed.fingerprint('Creator01');
    await assert.rejects(failed.rotate(['Creator01']));assert.equal(failed.fingerprint('Creator01'),before);
    console.log('PASS: encrypted password recovery after reload; no plaintext persistence; key loss/wrong key/tamper/account swap rejected; legacy hash compatibility; failed writes do not change credentials.');
  } finally { fs.rmSync(tmp,{recursive:true,force:true}); }
}
module.exports = { testCredentialExport };
