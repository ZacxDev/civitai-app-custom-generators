// Deeplink helpers: `?g=<key>` parse + share-URL build round-trip.

import { describe, expect, it } from 'vitest';

import { DEEPLINK_PARAM, buildShareUrl, parseDeeplinkKey, stripDeeplinkParam } from './deeplink.js';

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
