'use strict';
(() => {
  const q = new URLSearchParams(location.search);
  const url = q.get('url') || '';
  const code = q.get('code') || '';
  const desc = q.get('desc') || '';
  let host = url;
  try { host = new URL(url).hostname; } catch { /* keep raw */ }

  const messages = {
    ERR_NAME_NOT_RESOLVED: [`Can't find ${host}`, 'Check the address for typos, or check your connection.'],
    ERR_INTERNET_DISCONNECTED: ["You're offline", 'Check your network connection and try again.'],
    ERR_CONNECTION_REFUSED: [`${host} refused to connect`, 'The site might be down or blocking connections.'],
    ERR_CONNECTION_TIMED_OUT: [`${host} took too long to respond`, 'The site might be busy. Try again in a moment.'],
    ERR_CERT_COMMON_NAME_INVALID: ['Connection is not private', `The certificate for ${host} doesn't match the site.`],
    ERR_CERT_DATE_INVALID: ['Connection is not private', `The certificate for ${host} has expired.`],
    ERR_CERT_AUTHORITY_INVALID: ['Connection is not private', `The certificate for ${host} isn't trusted.`],
    ERR_BLOCKED_BY_CLIENT: ['Blocked by Coffee', 'This address is on an ad or tracker block list.'],
  };
  const key = desc.replace(/^net::/, '');
  const [title, detail] = code === 'crashed'
    ? ['Something went wrong', 'This page stopped responding. Try reloading it.']
    : messages[key] || [`Can't reach ${host || 'this page'}`, 'Something went wrong while loading this page.'];

  document.title = title;
  document.getElementById('title').textContent = title;
  document.getElementById('detail').textContent = detail;
  document.getElementById('code').textContent = key || code;
  document.getElementById('retry').onclick = () => window.coffee.send('nav:go', { url });
})();
