/* easyCube central participant labels; uses the native VDO.Ninja label message. AGPL-3.0. */
(() => {
  'use strict';
  const running = new WeakSet();
  window.easycubeParticipantLabel = {
    async start(active) {
      if (running.has(active)) return;running.add(active);
      let last = null;
      async function refresh() {
        if (document.getElementById('easycubeSessionEnded')) return;
        const controller = new AbortController();const timeout = setTimeout(()=>controller.abort(),4000);
        try {
          const response = await fetch('/api/me',{ credentials:'same-origin',cache:'no-store',signal:controller.signal });
          if (!response.ok) return;
          const data = await response.json();
          if (typeof data.mediaLabel !== 'string' || !data.mediaLabel) return;
          const label = typeof sanitizeLabel === 'function' ? sanitizeLabel(data.mediaLabel) : data.mediaLabel;
          if (last !== label || active.label !== label) {
            const previous = last;active.label = label;last = label;
            document.title = label + ' · Was weiß ich?!';
            if (previous !== null) active.sendMessage?.({changeLabel:true,value:label});
          }
        } catch { /* Preserve the current room and media if the account service is unavailable. */ }
        finally { clearTimeout(timeout); }
      }
      await refresh();
      async function poll() { await refresh();if (!document.getElementById('easycubeSessionEnded')) setTimeout(poll,10000); }
      setTimeout(poll,10000);
    }
  };
})();
