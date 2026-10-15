// Find-in-page bar for Muse for Linux.
//
// The page itself is the remote muse.ai app, so the bar is rendered
// here, from the preload, inside a shadow DOM (styles cannot leak in
// either direction). It talks to the main process over IPC only:
//   -> 'find:search' { text, forward }
//   -> 'find:stop'
//   <- 'find:show'
//   <- 'find:result' { activeMatchOrdinal, matches }
// Nothing is exposed to the page's own scripts.

const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  const host = document.createElement('div');
  host.id = 'muse-linux-findbar-host';
  host.style.cssText = 'position:fixed;top:12px;right:16px;z-index:2147483647;display:none;';
  const shadow = host.attachShadow({ mode: 'closed' });

  shadow.innerHTML = `
    <style>
      .bar {
        display: flex; align-items: center; gap: 6px;
        background: #1c1c21; color: #f0ead9; color-scheme: dark;
        border: 1px solid #3a3a44; border-radius: 10px;
        padding: 6px 8px; box-shadow: 0 8px 28px rgba(0,0,0,.45);
        font: 13px system-ui, sans-serif;
      }
      input {
        background: #121216; color: inherit; border: 1px solid #3a3a44;
        border-radius: 6px; padding: 5px 8px; width: 210px; outline: none;
      }
      input:focus { border-color: #2f6fd0; }
      .count { min-width: 52px; text-align: center; opacity: .75; font-size: 12px; }
      button {
        background: transparent; color: inherit; border: 0; cursor: pointer;
        border-radius: 6px; padding: 4px 7px; font-size: 13px;
      }
      button:hover { background: #2c2c34; }
    </style>
    <div class="bar">
      <input type="text" placeholder="Find in page" aria-label="Find in page">
      <span class="count"></span>
      <button data-act="prev" title="Previous (Shift+Enter)">&#8593;</button>
      <button data-act="next" title="Next (Enter)">&#8595;</button>
      <button data-act="close" title="Close (Esc)">&#10005;</button>
    </div>`;

  document.body.appendChild(host);

  const input = shadow.querySelector('input');
  const count = shadow.querySelector('.count');
  let lastText = '';

  function search(forward) {
    lastText = input.value;
    ipcRenderer.send('find:search', { text: lastText, forward });
  }
  function show() {
    host.style.display = 'block';
    input.focus();
    input.select();
  }
  function hide() {
    host.style.display = 'none';
    count.textContent = '';
    ipcRenderer.send('find:stop');
    window.focus();
  }

  input.addEventListener('input', () => search(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      search(!e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hide();
    }
  });
  shadow.querySelector('[data-act="next"]').addEventListener('click', () => search(true));
  shadow.querySelector('[data-act="prev"]').addEventListener('click', () => search(false));
  shadow.querySelector('[data-act="close"]').addEventListener('click', hide);

  window.addEventListener(
    'keydown',
    (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        show();
      }
    },
    true,
  );

  ipcRenderer.on('find:show', show);
  ipcRenderer.on('find:result', (_e, { activeMatchOrdinal, matches }) => {
    if (!lastText) {
      count.textContent = '';
    } else {
      count.textContent = matches ? `${activeMatchOrdinal}/${matches}` : '0/0';
    }
  });
});
