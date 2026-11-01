/* easyCube participant display names, 2026-11-01. AGPL-3.0. */
'use strict';
const fs = require('node:fs');
const { atomicJSON, participant } = require('./access-manager');
class DisplayNames {
  constructor(filename, getPolicy) {
    this.filename = filename;this.getPolicy = getPolicy;this.names = {};
    try {
      const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
      if (data.version !== 1 || !data.names || typeof data.names !== 'object' || Array.isArray(data.names)) throw new Error('Invalid display-name state');
      for (const [username, name] of Object.entries(data.names)) {
        if (!participant(getPolicy().accounts?.[username]) || this.normalize(name) !== name) throw new Error('Invalid display-name record');
      }
      this.names = data.names;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  normalize(value) {
    if (typeof value !== 'string') throw new Error('Bitte einen Namen eingeben.');
    const name = value.normalize('NFC').trim().replace(/ +/g, ' ');
    if ([...name].length > 60 || !/^[\p{L}\p{M}\p{N} .,'’:_()!+\-]*$/u.test(name)) throw new Error('Bitte höchstens 60 Zeichen verwenden: Buchstaben, Zahlen, Leerzeichen oder übliche Namenszeichen.');
    return name;
  }
  get(username) { return this.names[username] || ''; }
  mediaLabel(username) {
    if (!participant(this.getPolicy().accounts?.[username])) return null;
    return username + (this.get(username) ? ': ' + this.get(username) : '');
  }
  set(username, value) {
    if (!participant(this.getPolicy().accounts?.[username])) throw new Error('Dieses Konto hat keinen Teilnehmernamen.');
    const name = this.normalize(value);const next = { ...this.names };
    if (name) next[username] = name;else delete next[username];
    atomicJSON(this.filename, { version: 1, names: next });this.names = next;
    return { username, displayName: name, mediaLabel: this.mediaLabel(username) };
  }
}
module.exports = { DisplayNames };
