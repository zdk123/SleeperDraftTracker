(function (App) {
  'use strict';

  // Tiny app-wide event bus for cross-module notifications (sync status,
  // storage failures) that don't belong in the draft state itself.
  const handlers = new Map();
  App.bus = {
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => handlers.get(event).delete(fn);
    },
    emit(event, payload) {
      for (const fn of handlers.get(event) || []) {
        try {
          fn(payload);
        } catch (err) {
          console.error(`[bus] ${event} handler failed`, err);
        }
      }
    },
  };

  App.utils = {
    money(n) {
      return `$${Math.round(Number(n) || 0)}`;
    },

    uid(prefix) {
      return `${prefix || 'id'}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
    },

    debounce(fn, wait) {
      let timer = null;
      const wrapped = (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), wait);
      };
      wrapped.cancel = () => clearTimeout(timer);
      wrapped.flush = (...args) => {
        clearTimeout(timer);
        fn(...args);
      };
      return wrapped;
    },

    /** el('div', {class:'x', onclick:fn}, 'text' | childNode | [children]) */
    el(tag, attrs, children) {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs || {})) {
        if (value === null || value === undefined || value === false) continue;
        if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (key === 'class') {
          node.className = value;
        } else if (key === 'text') {
          node.textContent = value;
        } else if (key === 'html') {
          node.innerHTML = value;
        } else if (key === 'dataset') {
          Object.assign(node.dataset, value);
        } else {
          node.setAttribute(key, value === true ? '' : value);
        }
      }
      const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
      for (const child of list) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
      }
      return node;
    },

    clear(node) {
      while (node.firstChild) node.removeChild(node.firstChild);
      return node;
    },

    timeAgo(iso) {
      if (!iso) return 'never';
      const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
      if (seconds < 5) return 'just now';
      if (seconds < 60) return `${seconds}s ago`;
      if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
      return `${Math.round(seconds / 3600)}h ago`;
    },

    downloadFile(filename, text, mime) {
      const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
})((window.DraftApp = window.DraftApp || {}));
