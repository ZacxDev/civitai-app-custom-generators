// Deeplink helpers: `?g=<key>` parse + share-URL build round-trip.

import { describe, expect, it } from 'vitest';

import {
  DEEPLINK_PARAM,
  buildRunShareUrl,
  buildShareUrl,
  isRoutableKey,
  parseDeeplinkKey,
  parseRouteKey,
  routeForKey,
  stripDeeplinkParam,
} from './deeplink.js';

describe('parseDeeplinkKey', () => {
  it('extracts the key from a search string (with or without the leading ?)', () => {
    expect(parseDeeplinkKey('?g=shared:abc')).toBe('shared:abc');
    expect(parseDeeplinkKey('g=shared:abc')).toBe('shared:abc');
  });
  it('returns null when absent or blank', () => {
    expect(parseDeeplinkKey('')).toBeNull();
    expect(parseDeeplinkKey(undefined)).toBeNull();
    expect(parseDeeplinkKey('?foo=bar')).toBeNull();
    expect(parseDeeplinkKey('?g=')).toBeNull();
    expect(parseDeeplinkKey('?g=%20%20')).toBeNull(); // whitespace-only
  });
  it('picks the g param out of a multi-param query', () => {
    expect(parseDeeplinkKey('?a=1&g=k9&z=2')).toBe('k9');
  });

  it('does not throw on hostile / malformed input (returns a string or null)', () => {
    // Lenient percent-decoding + injection-shaped junk must never throw.
    expect(() => parseDeeplinkKey('?g=%')).not.toThrow();
    expect(() => parseDeeplinkKey('?g=%zz&x=%')).not.toThrow();
    expect(parseDeeplinkKey('?g="><img src=x onerror=alert(1)>')).toBe('"><img src=x onerror=alert(1)>');
    expect(parseDeeplinkKey('?g=' + 'a'.repeat(5000))).toHaveLength(5000); // huge key, no crash
  });
});

describe('buildShareUrl / stripDeeplinkParam round-trip', () => {
  it('sets ?g=<key> on the current href (self-referential, replacing any existing value)', () => {
    const url = buildShareUrl('https://custom-generators.example/?g=old#frag', 'shared:xyz');
    const parsed = new URL(url);
    expect(parsed.searchParams.get(DEEPLINK_PARAM)).toBe('shared:xyz');
    expect(parsed.hash).toBe('');
  });
  it('a built share URL round-trips back to the same key via parseDeeplinkKey', () => {
    const key = 'shared:round-trip';
    const url = buildShareUrl('https://host.example/apps/run/custom-generators', key);
    expect(parseDeeplinkKey(new URL(url).search)).toBe(key);
  });
  it('stripDeeplinkParam removes g so a reload does not re-trigger the deep-open', () => {
    const stripped = stripDeeplinkParam('https://host.example/?g=shared:xyz&keep=1');
    expect(parseDeeplinkKey(new URL(stripped).search)).toBeNull();
    expect(new URL(stripped).searchParams.get('keep')).toBe('1');
  });
});

describe('parseRouteKey (host subPath `g/<key>`)', () => {
  const ULID = '01JABCDEFGHJKMNPQRSTVWXYZ0';

  it('accepts exactly g/<key> and returns the key', () => {
    expect(parseRouteKey(`g/${ULID}`)).toBe(ULID);
    expect(parseRouteKey('g/a')).toBe('a'); // 1-char lower bound
    expect(parseRouteKey(`g/${'k'.repeat(64)}`)).toBe('k'.repeat(64)); // 64-char upper bound
    expect(parseRouteKey('g/Az09_-')).toBe('Az09_-'); // the whole alphabet
  });

  it.each([
    ['g/', 'empty key'],
    [`g/${'k'.repeat(65)}`, '65 chars'],
    ['../x', 'traversal'],
    ['g/a/b', 'extra segment'],
    [`x/${ULID}`, 'wrong prefix'],
    [`/g/${ULID}`, 'leading slash'],
    [`g/${ULID}/`, 'trailing slash'],
    ['g/..', 'dot-dot key'],
    ['g/a%2Fb', 'encoded separator'],
    ['g/a:b', 'colon'],
    [`G/${ULID}`, 'uppercase prefix'],
    [`g/${ULID}\n`, 'trailing newline'],
    ['', 'app root'],
  ])('rejects %j (%s)', (subPath) => {
    expect(parseRouteKey(subPath)).toBeNull();
  });

  it('returns null for absent input', () => {
    expect(parseRouteKey(null)).toBeNull();
    expect(parseRouteKey(undefined)).toBeNull();
  });

  it('routeForKey is its inverse for a routable key', () => {
    expect(parseRouteKey(routeForKey(ULID))).toBe(ULID);
    expect(isRoutableKey(ULID)).toBe(true);
    expect(isRoutableKey('shared:abc')).toBe(false);
    expect(isRoutableKey('')).toBe(false);
  });
});

describe('buildRunShareUrl', () => {
  const ULID = '01JABCDEFGHJKMNPQRSTVWXYZ0';

  it('points at the civitai.com run route for the given slug', () => {
    expect(
      buildRunShareUrl({ slug: 'custom-generators', key: ULID, href: 'https://custom-generators.civit.ai/' }),
    ).toBe(`https://civitai.com/apps/run/custom-generators/g/${ULID}`);
  });

  it('takes the slug from its argument, not a constant', () => {
    expect(buildRunShareUrl({ slug: 'other-app', key: ULID, href: 'https://x.example/' })).toBe(
      `https://civitai.com/apps/run/other-app/g/${ULID}`,
    );
  });

  it('round-trips: the link path after the slug parses back to the same key', () => {
    const url = new URL(buildRunShareUrl({ slug: 'custom-generators', key: ULID, href: 'https://x.example/' }));
    const subPath = url.pathname.replace(/^\/apps\/run\/custom-generators\//, '');
    expect(parseRouteKey(subPath)).toBe(ULID);
  });

  it('falls back to the self-referential ?g= link for a key the route cannot carry', () => {
    const url = buildRunShareUrl({ slug: 'custom-generators', key: 'shared:odd', href: 'https://x.example/run' });
    expect(new URL(url).origin).toBe('https://x.example');
    expect(parseDeeplinkKey(new URL(url).search)).toBe('shared:odd');
  });
});
