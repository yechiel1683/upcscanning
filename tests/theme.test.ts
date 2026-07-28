import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { THEME_STORAGE_KEY, themeInitScript } from '@/components/theme';

/**
 * The theme is plain CSS variables rather than a runtime library, so the things
 * that can silently break it are textual: a token that only one theme defines,
 * a hard-coded colour that ignores both, or an init script that stops running
 * before first paint.
 */

const css = readFileSync('src/app/globals.css', 'utf8');

function blockFor(selector: string): string {
  const start = css.indexOf(selector);
  expect(start, `${selector} block is missing`).toBeGreaterThan(-1);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

const darkBlock = blockFor(':root {');
const lightBlock = blockFor(":root[data-theme='light']");

function tokensIn(block: string): string[] {
  return [...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]!);
}

describe('theme tokens', () => {
  it('makes dark a true black canvas', () => {
    expect(darkBlock).toMatch(/--canvas:\s*#000000/);
  });

  it('makes light a true white canvas', () => {
    expect(lightBlock).toMatch(/--canvas:\s*#ffffff/);
  });

  it('defines every token in both themes', () => {
    const dark = tokensIn(darkBlock);
    const light = tokensIn(lightBlock);

    // A token defined in only one theme inherits the other's value, which is
    // how you get white text on white in exactly one mode.
    const missingInLight = dark.filter((t) => !light.includes(t));
    const missingInDark = light.filter((t) => !dark.includes(t));

    expect(missingInLight, `defined in dark but not light: ${missingInLight.join(', ')}`).toEqual([]);
    expect(missingInDark, `defined in light but not dark: ${missingInDark.join(', ')}`).toEqual([]);
  });

  it('sets color-scheme in both themes so form controls follow', () => {
    expect(darkBlock).toMatch(/color-scheme:\s*dark/);
    expect(lightBlock).toMatch(/color-scheme:\s*light/);
  });

  it('exposes the semantic roles components rely on', () => {
    for (const token of [
      '--canvas', '--surface', '--surface-2', '--line', '--fg', '--muted',
      '--subtle', '--accent', '--accent-fg',
    ]) {
      expect(tokensIn(darkBlock), `${token} is not defined`).toContain(token);
    }
  });
});

describe('theme init script', () => {
  it('defaults to dark when nothing is stored', () => {
    const html = { documentElement: { attr: '' } };
    const store: Record<string, string> = {};
    runInit(html, store);
    expect(html.documentElement.attr).toBe('dark');
  });

  it('honours a stored light preference', () => {
    const html = { documentElement: { attr: '' } };
    runInit(html, { [THEME_STORAGE_KEY]: 'light' });
    expect(html.documentElement.attr).toBe('light');
  });

  it('ignores a junk stored value rather than applying it', () => {
    const html = { documentElement: { attr: '' } };
    runInit(html, { [THEME_STORAGE_KEY]: 'chartreuse' });
    expect(html.documentElement.attr).toBe('dark');
  });

  it('falls back to dark when storage throws', () => {
    // Private browsing can make localStorage access throw outright.
    const html = { documentElement: { attr: '' } };
    const hostile = {
      getItem() {
        throw new Error('access denied');
      },
    };
    const fn = new Function('document', 'localStorage', themeInitScript);
    fn(asDocument(html), hostile);
    expect(html.documentElement.attr).toBe('dark');
  });
});

interface FakeHtml {
  documentElement: { attr: string };
}

function asDocument(html: FakeHtml) {
  return {
    documentElement: {
      setAttribute(_name: string, value: string) {
        html.documentElement.attr = value;
      },
    },
  };
}

function runInit(html: FakeHtml, store: Record<string, string>) {
  const localStorage = { getItem: (key: string) => store[key] ?? null };
  const fn = new Function('document', 'localStorage', themeInitScript);
  fn(asDocument(html), localStorage);
}
