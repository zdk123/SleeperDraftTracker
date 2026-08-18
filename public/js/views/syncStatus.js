(function (App) {
  'use strict';

  const { el, clear, timeAgo } = App.utils;

  // A persistent, glanceable pill. The important message it carries: red means
  // the spreadsheet copy is behind, NOT that anything was lost. The draft is
  // always safe locally, so the correct response to red is to keep going.

  const LABELS = {
    idle: ['Ready', 'ok'],
    pending: ['Saving…', 'busy'],
    syncing: ['Saving…', 'busy'],
    synced: ['Saved', 'ok'],
    offline: ['Offline', 'warn'],
    error: ['Sheet behind', 'bad'],
    disabled: ['Local only', 'muted'],
  };

  let node = null;

  function render(snapshot) {
    if (!node) return;
    const [label, kind] = LABELS[snapshot.status] || LABELS.idle;
    clear(node);
    node.className = `syncpill syncpill--${kind}`;
    node.title =
      (snapshot.detail || '') +
      (snapshot.lastSyncedAt ? `\nLast saved to the sheet ${timeAgo(snapshot.lastSyncedAt)}` : '') +
      '\nPicks are always saved on this computer first.';
    node.append(
      el('span', { class: 'syncpill__dot' }),
      el('span', { class: 'syncpill__text', text: label })
    );
  }

  App.views = App.views || {};
  App.views.syncStatus = {
    mount(container) {
      node = el('div', { class: 'syncpill syncpill--ok', role: 'status' });
      container.append(node);
      App.bus.on('sync:status', render);
      render(App.sync.snapshot());
      // Keep the relative "last saved" time in the tooltip fresh.
      setInterval(() => render(App.sync.snapshot()), 20000);
    },
  };
})(window.DraftApp);
