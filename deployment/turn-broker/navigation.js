/* Account-scoped home navigation, easyCube 2026-11-01. AGPL-3.0. */
'use strict';
class Navigation {
  constructor({ origin, getPolicy, links, viewers, allowEntry, displayNames }) {
    this.origin = origin; this.getPolicy = getPolicy; this.links = links; this.viewers = viewers; this.allowEntry = allowEntry;
    this.displayNames = displayNames;
  }
  personal(username) {
    const matches = Object.entries(this.links).filter(([token, entry]) => /^[A-Za-z0-9_-]{22}$/.test(token) && entry.username === username && this.allowEntry(username, entry.path));
    if (matches.length !== 1) throw new Error('No unique personal entry');
    return '/l/' + matches[0][0];
  }
  roomEntries(name) {
    const policy = this.getPolicy(); const room = policy.rooms?.[name];
    if (!room) throw new Error('Room is not configured');
    const publishers = Object.entries(this.links).filter(([, entry]) => policy.accounts?.[entry.username]?.role === 'codirector' && policy.accounts[entry.username].room === name && this.allowEntry(entry.username, entry.path));
    const talks = Object.entries(this.links).filter(([, entry]) => entry.username === 'Production' && this.allowEntry(entry.username, entry.path) && new URL(entry.path, this.origin).searchParams.get('room') === room.id);
    if (publishers.length !== 1 || talks.length !== 1 || !/^[A-Za-z0-9_-]{22}$/.test(talks[0][0])) throw new Error('Room navigation is incomplete');
    const publisher = new URL(publishers[0][1].path, this.origin);
    const talk = new URL(talks[0][1].path, this.origin);
    const code = new URLSearchParams(publisher.hash.replace(/^#\??/, '')).get('codirector');
    const key = new URLSearchParams(talk.hash.replace(/^#\??/, '')).get('turnkey');
    if (!/^[A-Za-z0-9]{28}$/.test(code || '') || !/^[a-f0-9]{64}$/i.test(key || '')) throw new Error('Room navigation is invalid');
    const query = new URLSearchParams({ director: room.id, nopush: '', totalroombitrate: '3000' });
    const path = '/?' + query + '#?codirector=' + code + '&turn=twilio&turnkey=' + key;
    if (!this.allowEntry('Production', path)) throw new Error('Director entry is not allowed');
    return { director: path, talk: '/l/' + talks[0][0] };
  }
  director(username, name) {
    const account = this.getPolicy().accounts?.[username];
    if (username !== 'Production' || account?.role !== 'director' || !account.rooms?.includes(name)) return null;
    return this.roomEntries(name).director;
  }
  home(username) {
    const policy = this.getPolicy(); const account = policy.accounts?.[username];
    if (!account) throw new Error('Unknown account');
    if (username === 'Production' && account.role === 'director') {
      return { username, title: 'Production · Übersicht', intro: 'Öffne den passenden Raum oder verwalte die Production-Zugänge.', default: '/home', sections: account.rooms.map(name => {
        const entries = this.roomEntries(name);
        return { title: name[0].toUpperCase() + name.slice(1), links: [{ label: 'Director öffnen', href: '/launch/director/' + name, description: 'Control Center ohne eigenen Rückkanal.' }, { label: 'Production-Talk öffnen', href: entries.talk, description: 'Als zusätzlicher Mikrofon-Teilnehmer beitreten.' }] };
      }).concat([{ title: 'Zugänge', links: [{ label: 'Passwörter verwalten', href: '/production-access', description: 'Production-Joker und -Creator verwalten.' }] }]) };
    }
    if (account.role === 'obs') {
      const sources = Object.entries(this.viewers).filter(([token, entry]) => /^[A-Za-z0-9_-]{32}$/.test(token) && policy.accounts?.[entry.participant]?.room === account.room);
      if (!sources.length) throw new Error('No OBS sources configured');
      return { username, title: 'OBS · ' + account.room[0].toUpperCase() + account.room.slice(1), intro: 'Die freigegebenen Einzelquellen für diesen Raum.', default: '/home', sections: [{ title: 'Kameraquellen', links: sources.map(([token, entry]) => ({ label: this.displayNames?.mediaLabel(entry.participant) || policy.accounts[entry.participant].label || entry.participant, href: '/obs/' + token, description: 'Einzelquelle für OBS.' })) }] };
    }
    const target = this.personal(username);
    return { username, title: 'Dein Zugang', intro: 'Dein persönlicher Zugang zur Produktion.', default: target, sections: [{ title: 'Persönlicher Zugang', links: [{ label: 'Zugang öffnen', href: target }] }] };
  }
}
module.exports = { Navigation };
