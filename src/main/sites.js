'use strict';
// Host helpers shared by the per-site features: ad blocker exceptions,
// clearing history for a site, clearing cookies for a site.

/** "https://www.Example.com/a?b" or "example.com" -> "example.com" ('' if it isn't a host). */
function normalizeHost(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s || /\s/.test(s)) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `http://${s.replace(/^\*\./, '')}`;
  try {
    const h = new URL(s).hostname.replace(/^www\./, '').replace(/\.$/, '');
    return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(h) ? h : '';
  } catch {
    return '';
  }
}

/** Host of a web address, without "www." ('' for anything that isn't http/https). */
function hostOf(url) {
  try {
    const u = new URL(String(url));
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

/** Whether `host` is `site` or one of its subdomains. */
function matches(host, site) {
  return !!host && !!site && (host === site || host.endsWith(`.${site}`));
}

module.exports = { normalizeHost, hostOf, matches };
