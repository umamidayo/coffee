'use strict';
// Stroke icons (24x24 grid). Kept inline: no requests, instant paint.
(() => {
  const s = (d, extra = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  window.Icons = {
    back: s('<path d="M15 18l-6-6 6-6"/>'),
    forward: s('<path d="M9 18l6-6-6-6"/>'),
    reload: s('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
    stop: s('<path d="M6 6l12 12M18 6L6 18"/>'),
    plus: s('<path d="M12 5v14M5 12h14"/>'),
    close: s('<path d="M7 7l10 10M17 7L7 17"/>'),
    star: s('<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/>'),
    starFilled: s('<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z" fill="currentColor"/>'),
    download: s('<path d="M12 4v11"/><path d="M7 10.5l5 5 5-5"/><path d="M5 20h14"/>'),
    shield: s('<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/>'),
    shieldOff: s('<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.3-7.5 9.5-4.3-1.2-7.5-4.9-7.5-9.5V6z"/><path d="M4 4l16 16"/>'),
    lock: s('<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7"/>'),
    unlock: s('<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 6.8-1.2"/>'),
    search: s('<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>'),
    globe: s('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.6 3.5 5.4 3.5 8.5s-1.1 5.9-3.5 8.5c-2.4-2.6-3.5-5.4-3.5-8.5s1.1-5.9 3.5-8.5z"/>'),
    settings: s('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    menu: s('<circle cx="12" cy="5.5" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="18.5" r="1.2" fill="currentColor"/>'),
    volume: s('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4 4 0 0 1 0 6"/>'),
    mute: s('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M16 9.5l5 5M21 9.5l-5 5"/>'),
    folder: s('<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
    file: s('<path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z"/><path d="M14 3.5V8h4.5"/>'),
    pause: s('<path d="M9 6v12M15 6v12"/>'),
    play: s('<path d="M8 5.5v13l10.5-6.5z"/>'),
    trash: s('<path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.8 12.2a1.5 1.5 0 0 0 1.5 1.3h6.4a1.5 1.5 0 0 0 1.5-1.3L17.5 7"/>'),
    check: s('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    arrowUp: s('<path d="M12 19V5M6 11l6-6 6 6"/>'),
    arrowDown: s('<path d="M12 5v14M6 13l6 6 6-6"/>'),
    sparkle: s('<path d="M12 3.5l1.9 5.2c.2.6.7 1.1 1.4 1.4l5.2 1.9-5.2 1.9c-.6.2-1.1.7-1.4 1.4L12 20.5l-1.9-5.2a2.3 2.3 0 0 0-1.4-1.4L3.5 12l5.2-1.9c.6-.2 1.1-.7 1.4-1.4z"/>'),
    history: s('<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4.5V9h4.5"/><path d="M12 8v4.5l3 2"/>'),
    minimize: '<svg viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>',
    maximize: '<svg viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    restore: '<svg viewBox="0 0 10 10"><rect x="0.5" y="2.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.5 2.5V1.8A1.3 1.3 0 0 1 3.8.5h4.4a1.3 1.3 0 0 1 1.3 1.3v4.4a1.3 1.3 0 0 1-1.3 1.3H7.5" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    winClose: '<svg viewBox="0 0 10 10"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" stroke-width="1"/></svg>',
    // The Coffee mark: a single bean (same shape as the app icon).
    logo: '<svg viewBox="0 0 32 32"><defs><mask id="bean-crease"><rect width="32" height="32" fill="#fff"/><path d="M16 4c-3 5 3 10.6 0 24" stroke="#000" stroke-width="1.9" fill="none"/></mask></defs><g transform="rotate(38 16 16)"><ellipse cx="16" cy="16" rx="7.4" ry="10.5" fill="currentColor" mask="url(#bean-crease)"/></g></svg>',
  };
})();
