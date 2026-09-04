// Motion + the `prefers-reduced-motion` guard.
//
// The measurement here deliberately mirrors the one taken against the LIVE app
// (81 elements, 0 with a CSS animation, 14 with a non-zero transitionDuration)
// so the before/after numbers are comparable: walk every element under the
// render root and read `getComputedStyle`.
//
// 🔴 Two jsdom facts this file is built on, both measured rather than assumed:
//   1. jsdom resolves LONGHAND `animation-name` / `animation-duration` /
//      `transition-duration` from an injected <style>, but does NOT expand the
//      `animation:` / `transition:` SHORTHAND — a shorthand rule reads back as
//      `""`. ../motion.ts therefore uses longhands only.
//   2. an element with no animation reads `animationName === ''` in jsdom, not
//      the browser's `'none'`. The predicate below accepts both, so the same
//      count means the same thing in either environment.

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Browse, type BrowseProps } from './components/Browse.js';
import { palette } from './theme.js';
import { buildPublishPayload, newButton } from './lib/generator.js';
import {
  CLASS_LIFT,
  CLASS_RISE,
  CLASS_TICK,
  MOTION_CSS,
  MOTION_STYLE_MARKER,
  STAGGER_MAX_STEPS,
  STAGGER_STEP_MS,
  injectMotionStyles,
  motionClass,
  staggerDelayMs,
  useMotion,
} from './motion.js';
import { setReducedMotion } from './test-setup.js';
import type { GeneratorConfig } from './types.js';
import type { SharedListItem } from '@civitai/blocks-react';

const c = palette();

function item(key: string, title: string, count = 0): SharedListItem {
  const config: GeneratorConfig = {
    name: title,
    description: `${title} description`,
    buttons: [newButton({ params: { steps: 25, width: 1024, height: 1024, quantity: 1 } })],
  };
  return { key, authorUserId: 7, value: buildPublishPayload(config), count, viewerVoted: false, createdAt: new Date(), updatedAt: new Date() };
}

function renderBrowse(over: Partial<BrowseProps> = {}) {
  const props: BrowseProps = {
    c,
    loading: false,
    error: null,
    discover: [],
    discoverTruncated: false,
    myDrafts: [],
    myPublished: [],
    viewerId: 99,
    onSignIn: vi.fn(),
    onCreate: vi.fn(),
    onOpenPublished: vi.fn(),
    onOpenDraft: vi.fn(),
    onEditDraft: vi.fn(),
    onDeleteDraft: vi.fn(),
    onDeletePublished: vi.fn(),
    onVote: vi.fn(async () => 1),
    onFork: vi.fn(),
    onShare: vi.fn(async () => true),
    onReport: vi.fn(async () => {}),
    coverUrlFor: () => null,
    onRetry: vi.fn(),
    ...over,
  };
  return { ...render(<Browse {...props} />), props };
}

/** `true` when this element actually carries a CSS animation. */
function isAnimated(el: Element): boolean {
  const name = getComputedStyle(el).animationName;
  return !!name && name !== 'none';
}

/** `true` when this element has a non-zero transition duration. */
function hasTransition(el: Element): boolean {
  const d = getComputedStyle(el).transitionDuration;
  if (!d) return false;
  // A list ("160ms, 160ms") counts if ANY leg is non-zero.
  return d.split(',').some((part) => parseFloat(part) > 0);
}

/** The live-app measurement, run over a rendered tree. */
export function measureMotion(root: ParentNode) {
  const els = [...root.querySelectorAll('*')];
  return {
    total: els.length,
    animated: els.filter(isAnimated).length,
    transitioned: els.filter(hasTransition).length,
  };
}

const THREE = [item('k1', 'Alpha'), item('k2', 'Beta'), item('k3', 'Gamma')];

describe('motion — the stylesheet', () => {
  beforeEach(() => setReducedMotion(false));

  it('injects exactly once, behind its marker', () => {
    injectMotionStyles();
    injectMotionStyles();
    injectMotionStyles();
    expect(document.querySelectorAll(`style[${MOTION_STYLE_MARKER}]`)).toHaveLength(1);
  });

  it('animates ONLY compositor properties — never a layout property', () => {
    // Cheap, structural, and the thing that actually keeps this cheap at 60fps:
    // no keyframe or transition may name width/height/top/left/margin/padding.
    const LAYOUT = /\b(width|height|top|left|right|bottom|margin|padding|inset)\s*:/g;
    // Strip the declarations we know are safe before scanning, so a false hit is
    // a real one. (`transition-property` is checked separately below.)
    const hits = MOTION_CSS.match(LAYOUT) ?? [];
    expect(hits).toEqual([]);

    const props = [...MOTION_CSS.matchAll(/transition-property:\s*([^;]+);/g)].map((m) => m[1]);
    expect(props.length).toBeGreaterThan(0);
    for (const p of props) {
      for (const one of p.split(',')) {
        expect(['transform', 'box-shadow', 'opacity']).toContain(one.trim());
      }
    }
  });

  it('caps the entrance stagger so a long list never cascades', () => {
    expect(staggerDelayMs(0)).toBe(0);
    expect(staggerDelayMs(1)).toBe(STAGGER_STEP_MS);
    expect(staggerDelayMs(STAGGER_MAX_STEPS)).toBe(STAGGER_MAX_STEPS * STAGGER_STEP_MS);
    // Item 6 and item 600 start together — the cascade stops growing.
    expect(staggerDelayMs(600)).toBe(staggerDelayMs(STAGGER_MAX_STEPS));
  });

  it('withholds motion on the FIRST PAINT, before any effect has run', () => {
    // `usePrefersReducedMotion()` reads matchMedia twice: once as lazy initial
    // state, once from an effect that also subscribes to `change`. In a mounted
    // tree the effect flushes before any assertion can see the initial value, so
    // a test that only calls `render()` CANNOT tell the two apart — hardcoding
    // the initial read to `false` survives the whole rest of this file.
    //
    // It is not redundant, though: the initial read is what stops a
    // reduced-motion viewer seeing one frame of animation before the effect
    // corrects it. `renderToStaticMarkup` runs NO effects, so it is the only
    // vantage point from which that first frame is observable.
    function Probe() {
      const motion = useMotion();
      return <div id="probe" className={motionClass(motion, CLASS_RISE)} />;
    }

    setReducedMotion(true);
    expect(renderToStaticMarkup(<Probe />)).not.toContain(CLASS_RISE);

    setReducedMotion(false);
    expect(renderToStaticMarkup(<Probe />)).toContain(CLASS_RISE);
  });

  it('motionClass withholds every class when motion is off', () => {
    expect(motionClass(true, CLASS_LIFT, CLASS_RISE)).toBe(`${CLASS_LIFT} ${CLASS_RISE}`);
    expect(motionClass(false, CLASS_LIFT, CLASS_RISE)).toBeUndefined();
    // No empty class="" attribute when nothing is selected.
    expect(motionClass(true, false && CLASS_TICK)).toBeUndefined();
  });
});

describe('motion — the live-app measurement, reproduced', () => {
  it('MOTION ON: the browse tree carries animations and transitions', () => {
    setReducedMotion(false);
    const { container } = renderBrowse({ discover: THREE });
    const m = measureMotion(container);

    // The claim: 0 -> N. Every discover card + the intro panel gets an entrance
    // animation, and every card gets a hover-lift transition.
    expect(m.animated).toBeGreaterThan(0);
    expect(m.transitioned).toBeGreaterThan(0);

    const cards = screen.getAllByTestId('published-card');
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(card.className).toContain(CLASS_RISE);
      expect(card.className).toContain(CLASS_LIFT);
      expect(isAnimated(card)).toBe(true);
      expect(hasTransition(card)).toBe(true);
    }
    // The intro panel fades in too.
    expect(screen.getByTestId('intro-panel').className).toContain(CLASS_RISE);
    // 4 animated elements at minimum: 3 cards + the intro panel.
    expect(m.animated).toBeGreaterThanOrEqual(4);
  });

  it('MOTION ON: the entrance is staggered, and the stagger is capped', () => {
    setReducedMotion(false);
    const many = Array.from({ length: 9 }, (_, i) => item(`k${i}`, `Gen ${i}`));
    renderBrowse({ discover: many });
    const delays = screen.getAllByTestId('published-card').map((el) => (el as HTMLElement).style.animationDelay);
    expect(delays.slice(0, 3)).toEqual(['0ms', `${STAGGER_STEP_MS}ms`, `${2 * STAGGER_STEP_MS}ms`]);
    // Everything past the cap shares the last delay.
    const capped = `${STAGGER_MAX_STEPS * STAGGER_STEP_MS}ms`;
    expect(delays.slice(STAGGER_MAX_STEPS)).toEqual(Array(9 - STAGGER_MAX_STEPS).fill(capped));
  });

  it('MOTION ON: the vote count ticks only AFTER the count moves', async () => {
    setReducedMotion(false);
    const onVote = vi.fn(async () => 1);
    renderBrowse({ discover: [item('k1', 'Alpha', 0)], onVote });

    const card = screen.getByTestId('published-card');
    const before = within(card).getByTestId('published-votes').querySelector('span')!;
    // A freshly-painted list must be still — no tick on first render.
    expect(before.className).not.toContain(CLASS_TICK);
    expect(isAnimated(before)).toBe(false);

    await userEvent.click(within(card).getByTestId('vote-button'));

    const after = within(card).getByTestId('published-votes').querySelector('span')!;
    expect(after).toHaveTextContent('1');
    expect(after.className).toContain(CLASS_TICK);
    expect(isAnimated(after)).toBe(true);
    expect(onVote).toHaveBeenCalledTimes(1);
  });

  it('MOTION ON: a SECOND vote replays the tick (new node, not a reused one)', async () => {
    setReducedMotion(false);
    let next = 1;
    const onVote = vi.fn(async () => next++);
    renderBrowse({ discover: [item('k1', 'Alpha', 0)], onVote });
    const card = screen.getByTestId('published-card');
    const countSpan = () => within(card).getByTestId('published-votes').querySelector('span')!;

    await userEvent.click(within(card).getByTestId('vote-button'));
    const first = countSpan();
    await userEvent.click(within(card).getByTestId('vote-button'));
    const second = countSpan();

    // A CSS animation only restarts on a NEW element (or a changed
    // animation-name). React reuses a node across re-renders, so the tick must be
    // keyed — if it is not, `second` IS `first` and the second vote is silent.
    expect(second).not.toBe(first);
    expect(second.className).toContain(CLASS_TICK);
    expect(isAnimated(second)).toBe(true);
  });
});

describe('motion — prefers-reduced-motion: reduce (accessibility guard)', () => {
  it('REDUCED: not one element in the browse tree animates or transitions from our CSS', () => {
    setReducedMotion(true);
    const { container } = renderBrowse({ discover: THREE, myDrafts: [] });

    // The guard's OWN assertion: every motion class is withheld, so there is
    // nothing for the stylesheet to select. Assert the classes AND the resulting
    // computed style, because a class check alone would pass if the CSS moved.
    for (const cls of [CLASS_RISE, CLASS_LIFT, CLASS_TICK]) {
      expect(container.querySelectorAll(`.${cls}`)).toHaveLength(0);
    }
    const cards = screen.getAllByTestId('published-card');
    expect(cards).toHaveLength(3);
    for (const card of cards) {
      expect(isAnimated(card)).toBe(false);
      expect(hasTransition(card)).toBe(false);
      // No stray inline animation-delay either.
      expect((card as HTMLElement).style.animationDelay).toBe('');
    }
    expect(screen.getByTestId('intro-panel').className).not.toContain(CLASS_RISE);
  });

  it('REDUCED: the vote still lands, it just does not tick', async () => {
    setReducedMotion(true);
    const onVote = vi.fn(async () => 1);
    renderBrowse({ discover: [item('k1', 'Alpha', 0)], onVote });
    const card = screen.getByTestId('published-card');
    await userEvent.click(within(card).getByTestId('vote-button'));
    const span = within(card).getByTestId('published-votes').querySelector('span')!;
    // The FUNCTION is untouched — only the motion is withheld.
    expect(span).toHaveTextContent('1');
    expect(span.className).not.toContain(CLASS_TICK);
    expect(isAnimated(span)).toBe(false);
  });

  it('REDUCED vs ON is a real difference, not a vacuous zero (positive control)', () => {
    // The negative arm above asserts a ZERO. A zero is indistinguishable from a
    // probe wired to nothing, so measure the SAME tree with motion ON and watch
    // the number move.
    setReducedMotion(true);
    const off = measureMotion(renderBrowse({ discover: THREE }).container);
    cleanup();

    setReducedMotion(false);
    const on = measureMotion(renderBrowse({ discover: THREE }).container);

    expect(off.total).toBe(on.total); // same tree, same element count
    expect(off.animated).toBe(0);
    expect(on.animated).toBeGreaterThanOrEqual(4);
    expect(on.transitioned).toBeGreaterThan(off.transitioned);
  });
});
