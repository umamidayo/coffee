'use strict';
// What's new in each version, shown on the What's new page (coffee://whats-new,
// opened from Settings → About).
//
// Newest first. Keep the version being released plus the three before it
// (the page shows at most four); drop older ones when you add a new one.
// `npm run release` refuses to publish a version that has no notes here.
//
// Write for people using Coffee, not for developers: what they can do now
// and what got better, in plain words.

module.exports = [
  {
    version: '0.1.17',
    date: '2026-11-20',
    title: 'Private windows, and a lighter ad blocker',
    sections: [
      {
        heading: 'Private windows',
        items: [
          'Ctrl+Shift+N now opens a private window instead of a private tab. Everything you open from it stays private: links, new tabs, duplicates and bookmarks.',
          'Private and normal tabs never mix. A private window has a violet frame and "(Private)" in its title, and tabs can\'t be moved between private and normal windows.',
          'Right-click a link and choose "Open link in private window" to open it in your private window.',
          'Settings, History and What\'s new always open in a normal window.',
        ],
      },
      {
        heading: 'Faster and lighter',
        items: [
          'The ad blocker uses about 130 MB less memory. Updating the filter lists now happens in the background without leaving that memory behind.',
          'Turning ad blocking off now frees its memory too.',
        ],
      },
      {
        heading: 'Also',
        items: [
          'Tabs on top with icons only now show a close button when you hover them.',
          'The ⋮ menu has "Show tab titles", the same switch as in Settings.',
        ],
      },
    ],
  },
  {
    version: '0.1.16',
    date: '2026-11-20',
    title: 'Little things that add up',
    sections: [
      {
        heading: 'See where you are',
        items: [
          'Hover a link and its address appears in the bottom corner of the page, like other browsers. Rest on it a moment to see the whole address.',
          'Rest the pointer on a tab to see its title, address and a preview of the page, so tabs from the same site are easy to tell apart.',
          'Every toolbar button now says what it does, and its shortcut, when you hover it.',
        ],
      },
      {
        heading: 'Find your tabs',
        items: [
          'Search tabs (Ctrl+Shift+A) lists every open tab in every window. Type to filter, press Enter to switch.',
          'The address bar offers "Switch to tab" when the page you\'re typing is already open.',
        ],
      },
      {
        heading: 'Split view and windows, always on',
        items: [
          'Multiple windows and split view no longer need turning on in Settings.',
          'Right-click a link to open it in split view or in a new window.',
        ],
      },
      {
        heading: 'Handy shortcuts',
        items: [
          'Ctrl+Shift+C copies the page\'s address. Right-click a link and choose "Copy clean link" to leave out tracking bits.',
          'Ctrl+M mutes a tab, Ctrl+Shift+PgUp/PgDn moves it, Ctrl+Shift+W closes the window.',
          'Ctrl+Enter in the address bar turns a word into www.word.com. Shift+Delete removes a page from your history suggestions.',
          'Ctrl+F starts with the text you selected on the page.',
        ],
      },
      {
        heading: 'Also',
        items: [
          'Duplicating a tab keeps its back and forward history. Middle-click Back, Forward or Reload to open that page in a new tab.',
          'Double-click empty space in the side bar for a new tab.',
          'Select an address on a page and right-click to go straight to it.',
          'Popup shadows are no longer cut off.',
          'A What\'s new page (Settings → About) tells you what changed in each version.',
        ],
      },
    ],
  },
  {
    version: '0.1.15',
    date: '2026-11-20',
    title: 'Stay signed in',
    sections: [
      {
        items: [
          'Sites that keep you signed in "until the browser closes" now stay signed in when Coffee restarts or updates, as long as Restore tabs is on. They\'re saved encrypted, and clearing your browsing data clears them too.',
          'Recent sign-ins are no longer lost when an update installs.',
        ],
      },
    ],
  },
  {
    version: '0.1.14',
    date: '2026-11-20',
    title: 'A nicer installer',
    sections: [
      {
        items: [
          'The setup wizard has Coffee artwork, a new welcome screen, and a finish screen that can open Coffee right away.',
        ],
      },
    ],
  },
];
