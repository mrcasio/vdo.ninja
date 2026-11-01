/* easyCube room-scoped access-list downloads and individual sharing, 2026-11-01. AGPL-3.0. */
'use strict';
const fs = require('node:fs');
function inline(value) {
  const text = String(value);const runs = text.match(/`+/g) || [];const delimiter = '`'.repeat(1 + Math.max(0,...runs.map(x=>x.length)));
  return delimiter + (/^ | $|^`|`$/.test(text) ? ' ' + text + ' ' : text) + delimiter;
}
function plain(value) { return String(value).replace(/[\\`*_[\]{}()#+.!|<>]/g,'\\$&'); }
class AccountDownloads {
  constructor({ origin, getPolicy, navigation, credentials, passwordFile, displayNames }) {
    Object.assign(this, { origin, getPolicy, navigation, credentials, passwordFile, displayNames });
  }
  password(username) {
    const recovered = this.credentials.exportPassword(username);
    if (recovered) return recovered;
    let stored = { version: 1, accounts: {} };
    try {
      stored = JSON.parse(fs.readFileSync(this.passwordFile, 'utf8'));
      if (stored.version !== 1 || !stored.accounts || typeof stored.accounts !== 'object' || Array.isArray(stored.accounts)) throw new Error('Invalid password export source');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const saved = stored.accounts[username];
    return saved && typeof saved.password === 'string' && saved.password.length >= 1 && saved.password.length <= 256 && !/[\r\n\x00]/.test(saved.password) &&
      /^[a-f0-9]{64}$/.test(saved.fingerprint || '') && saved.fingerprint === this.credentials.fingerprint(username) ? saved.password : null;
  }
  share(username) {
    const account = this.getPolicy().accounts?.[username];
    if (!account || !['guest','participant','creator'].includes(account.role)) throw new Error('Only participant access can be shared');
    const password = this.password(username);if (!password) return null;
    const name = this.displayNames.get(username);
    const room = account.room[0].toUpperCase() + account.room.slice(1);
    return { username, text: (name ? 'Hallo ' + name + ',\n\n' : '') + 'dein Zugang zu „Was weiß ich?! – Frag die anderen!“ (' + room + '):\n\nAnmelden: ' + this.origin + '/\nBenutzername: ' + username + '\nPasswort: ' + password + '\n\nNach der Anmeldung öffnet sich dein persönlicher Zugang automatisch.' };
  }
  render(roomName) {
    const policy = this.getPolicy();
    if (!['test', 'staging', 'production'].includes(roomName) || !policy.rooms?.[roomName] ||
        !policy.accounts?.Production?.rooms?.includes(roomName)) throw new Error('Room is not available');
    const title = roomName[0].toUpperCase() + roomName.slice(1);
    const entries = Object.entries(policy.accounts).filter(([username, account]) => account.room === roomName || username === 'Production');
    const lines = ['# Was weiß ich?! · ' + title, '', '## Anmeldung', '',
      '**Adresse:** [' + this.origin.replace(/^https?:\/\//,'') + '](' + this.origin + '/)', '',
      'Nach der Anmeldung öffnet sich der persönliche Zugang automatisch. Production erhält die Raumauswahl.', '',
      '**Erstellt:** ' + new Date().toISOString() + '  ', '**Konten:** ' + entries.length, '', '## Zugangsdaten', ''];
    for (const [username, account] of entries) {
      const role = username === 'Production' ? 'Haupt-Director / Production' : account.role === 'codirector' ? 'Rückkanal / Co-Director' : account.role === 'obs' ? 'OBS-Sammelkonto' : account.role === 'guest' ? 'Joker' : /^Creator/.test(account.label || username) ? 'Creator' : 'Host';
      const name = this.displayNames.get(username);
      lines.push('### ' + inline(username) + (name ? ': ' + plain(name) : ''), '',
        '- **Benutzername:** ' + inline(username), '- **Rolle:** ' + plain(role));
      if (name) lines.push('- **Anzeigename:** ' + plain(name));
      const password = this.password(username);const rotated = this.credentials.overrides.accounts[username];
      lines.push('- **Passwort:** ' + (password ? inline(password) : '**NICHT VERFÜGBAR**'));
      if (rotated?.changedAt) lines.push('- **Zuletzt erneuert:** ' + rotated.changedAt);
      lines.push('');
    }
    const obsAccount = entries.find(([,account])=>account.role==='obs');
    if (obsAccount) {
      lines.push('## OBS-Einzelquellen', '', 'Diese Links direkt in OBS eintragen. Eine Anmeldung ist dafür nicht erforderlich.', '', '| Quelle | OBS-Link |', '| --- | --- |');
      const home = this.navigation.home(obsAccount[0]);
      for (const group of home.sections) for (const item of group.links) lines.push('| ' + plain(item.label) + ' | [Quelle öffnen](' + this.origin + item.href + ') |');
      lines.push('');
    }
    return { filename: title + '-Zugaenge-' + new Date().toISOString().slice(0, 10) + '.md', text: lines.join('\n') + '\n' };
  }
}
module.exports = { AccountDownloads };
