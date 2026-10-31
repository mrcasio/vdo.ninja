/* easyCube session takeover and receiver-side peer revocation, 2026-10-31. AGPL-3.0. */
(() => {
  'use strict';
  const NativeWebSocket = window.WebSocket;
  let stopped = false;
  const revokedPeers = new Set();
  function current() { try { return typeof session === 'undefined' ? null : session; } catch { return null; } }
  function closePeer(uuid) {
    const active = current();
    if (!active || typeof uuid !== 'string') return;
    try { active.closeRPC?.(uuid, true); } catch { /* Peer may already be closed. */ }
    try { active.closePC?.(uuid); } catch { /* Peer may already be closed. */ }
  }
  function finish(reason) {
    if (stopped) return;
    stopped = true;
    const active = current();
    try { active?.hangup?.(); } catch { /* Continue with the local stop below. */ }
    for (const element of document.querySelectorAll('video,audio')) {
      try { element.srcObject?.getTracks().forEach(track => track.stop()); element.srcObject = null; } catch { /* Already stopped. */ }
    }
    function show() {
      if (document.getElementById('easycubeSessionEnded')) return;
      const overlay = document.createElement('div');
      overlay.id = 'easycubeSessionEnded';
      Object.assign(overlay.style, { position: 'fixed', inset: '0', zIndex: '2147483647', background: '#10224d', color: '#fff', display: 'grid', placeItems: 'center', padding: '28px', font: '18px/1.5 system-ui' });
      const panel = document.createElement('div'); panel.style.maxWidth = '580px';
      const heading = document.createElement('h1'); heading.textContent = 'Diese Sitzung wurde beendet';
      const text = document.createElement('p');
      text.textContent = reason === 'message-rate-exceeded' ? 'Die Verbindung wurde wegen ungewöhnlich vieler Nachrichten beendet. Bitte melde dich bei der Produktion.' : 'Dein Zugang wurde auf einem anderen Gerät geöffnet, ist abgelaufen oder wurde von der Produktion erneuert. Kamera und Mikrofon sind auf dieser Seite getrennt.';
      const button = document.createElement('button'); button.textContent = 'Erneut anmelden'; button.style.padding = '12px 20px';
      button.addEventListener('click', () => location.reload());
      panel.append(heading, text, button); overlay.append(panel); document.documentElement.append(overlay);
    }
    show(); setTimeout(show, 1600);
  }
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      const target = new URL(url, location.href);
      const signaling = target.host === location.host && target.pathname === '/ws';
      if (signaling && stopped) throw new DOMException('Session ended', 'InvalidStateError');
      if (protocols === undefined) super(url); else super(url, protocols);
      if (!signaling) return;
      this.addEventListener('message', event => {
        if (stopped) { event.stopImmediatePropagation(); return; }
        if (typeof event.data !== 'string') return;
        let data; try { data = JSON.parse(event.data); } catch { return; }
        if (data?.request === 'easycubeAccessRevoked') { event.stopImmediatePropagation(); finish(data.reason); }
        else if (data?.request === 'easycubePeerRevoked') { event.stopImmediatePropagation(); revokedPeers.add(data.UUID); closePeer(data.UUID); setTimeout(() => closePeer(data.UUID), 1000); }
        else if (revokedPeers.has(data?.UUID)) event.stopImmediatePropagation();
      });
      this.addEventListener('close', event => {
        if (event.code === 4001) { event.stopImmediatePropagation(); finish(event.reason); }
      });
    }
  };
  document.addEventListener('DOMContentLoaded', async () => {
    if (document.documentElement.classList.contains('show-output')) return;
    try {
      const response = await fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' });
      if (!response.ok) return;
      const data = await response.json();
      if (!data.canManageProductionAccess) return;
      const link = document.createElement('a'); link.href = '/production-access'; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = 'Zugänge verwalten'; link.style.cssText = 'color:#a4efff;margin:0 12px;font:14px system-ui';
      document.getElementById('easycubeLogoutForm')?.prepend(link);
    } catch { /* Core room UI remains usable if the account service is unavailable. */ }
  });
})();
