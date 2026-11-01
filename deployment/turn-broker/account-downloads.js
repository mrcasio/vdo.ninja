/* easyCube room-scoped access-list downloads, 2026-11-01. AGPL-3.0. */
'use strict';
const fs = require('node:fs');
class AccountDownloads {
  constructor({ origin, getPolicy, navigation, credentials, passwordFile }) {
    Object.assign(this, { origin, getPolicy, navigation, credentials, passwordFile });
  }
  render(roomName) {
    const policy = this.getPolicy();
    if (!['test', 'staging', 'production'].includes(roomName) || !policy.rooms?.[roomName] ||
        !policy.accounts?.Production?.rooms?.includes(roomName)) throw new Error('Room is not available');
    let stored = { version: 1, accounts: {} };
    try {
      stored = JSON.parse(fs.readFileSync(this.passwordFile, 'utf8'));
      if (stored.version !== 1 || !stored.accounts || typeof stored.accounts !== 'object' || Array.isArray(stored.accounts)) throw new Error('Invalid password export source');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const title = roomName[0].toUpperCase() + roomName.slice(1);
    const entries = Object.entries(policy.accounts).filter(([username, account]) => account.room === roomName || username === 'Production');
    const lines = ['Was weiß ich?! · ' + title + ' · vollständige Zugangsliste',
      'Erstellt: ' + new Date().toISOString(), 'Konten: ' + entries.length,
      'Enthält die für diesen Raum freigegebenen Konten und Links.',
      'Passwörter werden nur ausgegeben, wenn ihr gespeicherter Stand noch gültig ist.',
      'Erneuerte Passwörter werden aus dem verschlüsselten Exportbestand ergänzt.', ''];
    for (const [username, account] of entries) {
      const role = username === 'Production' ? 'Haupt-Director / Production' : account.role === 'codirector' ? 'Rückkanal / Co-Director' : account.role === 'obs' ? 'OBS-Sammelkonto' : account.role === 'guest' ? 'Joker' : /^Creator/.test(account.label || username) ? 'Creator' : 'Host';
      lines.push('[' + username + ']', 'Benutzer: ' + username, 'Rolle: ' + role, 'Name: ' + (account.label || username));
      const saved = stored.accounts[username];
      const original = saved && typeof saved.password === 'string' && saved.password.length >= 1 && saved.password.length <= 256 && !/[\r\n\x00]/.test(saved.password) &&
        /^[a-f0-9]{64}$/.test(saved.fingerprint || '') && saved.fingerprint === this.credentials.fingerprint(username) ? saved.password : null;
      const password = this.credentials.exportPassword(username) || original;
      const rotated = this.credentials.overrides.accounts[username];
      lines.push('Passwort: ' + (password || (rotated ? 'NICHT ERNEUT AUSLESBAR (bereits erneuert; gespeicherte Liste dieser Änderung verwenden)' : 'NICHT VERFÜGBAR (in der Downloadquelle nicht hinterlegt)')));
      if (rotated?.changedAt) lines.push('Zuletzt erneuert: ' + rotated.changedAt);
      if (username === 'Production') {
        const director = this.navigation.director(username, roomName);
        if (!director) throw new Error('Director destination is unavailable');
        lines.push('Director-Link (ohne Rückkanal): ' + this.origin + director,
          'Production-Talk: ' + this.origin + this.navigation.roomEntries(roomName).talk,
          'Übersicht: ' + this.origin + '/home', 'Verwaltung: ' + this.origin + '/production-access');
      } else {
        const home = this.navigation.home(username);
        if (home.default !== '/home') lines.push('Persönlicher Link: ' + this.origin + home.default);
        else {
          lines.push('Quellenübersicht: ' + this.origin + '/home');
          for (const section of home.sections) for (const item of section.links) lines.push('OBS ' + item.label + ': ' + this.origin + item.href);
        }
      }
      lines.push('');
    }
    return { filename: title + '-Zugaenge-' + new Date().toISOString().slice(0, 10) + '.txt', text: lines.join('\n') + '\n' };
  }
}
module.exports = { AccountDownloads };
