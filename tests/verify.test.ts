import { describe, expect, it } from 'vitest';

import { interpret } from '@/server/providers/llm/verify';

/**
 * This is the code that decides whether a wrong product reaches a customer's
 * catalog, so it is tested for both directions of failure. Letting one through
 * is what happened — a body wash filed as a box of tea. But rejecting real
 * photographs of the right product on a shaky answer would quietly empty the
 * catalog instead, and that is the failure nobody notices until the export is
 * half the size it should be.
 */

describe('interpret', () => {
  it('accepts an image the verifier confirms', () => {
    const result = interpret('{"shown":"a bottle of body wash","depicts":true,"confidence":0.9}');
    expect(result.verdict).toBe('match');
  });

  it('rejects a confidently different product', () => {
    const result = interpret('{"shown":"a box of Lipton black tea","depicts":false,"confidence":0.95}');
    expect(result.verdict).toBe('mismatch');
    expect(result.reason).toContain('Lipton');
  });

  it('does not reject on an unconfident no', () => {
    // A hesitant "no" from a model squinting at a thumbnail is not grounds for
    // discarding a real photograph.
    const result = interpret('{"shown":"unclear","depicts":false,"confidence":0.3}');
    expect(result.verdict).toBe('unknown');
  });

  it('treats a missing confidence as no confidence at all', () => {
    // Absent means unknown, not certain. Defaulting the other way would turn
    // every malformed answer into a discarded product.
    const result = interpret('{"shown":"something","depicts":false}');
    expect(result.verdict).toBe('unknown');
  });

  it('passes through when the verdict field is missing', () => {
    expect(interpret('{"shown":"a bottle"}').verdict).toBe('unknown');
  });

  it('passes through on unparseable output', () => {
    expect(interpret('I think it looks fine!').verdict).toBe('unknown');
    expect(interpret('').verdict).toBe('unknown');
  });

  it('clamps a confidence outside 0 to 1 rather than trusting it', () => {
    expect(interpret('{"shown":"tea","depicts":false,"confidence":7}').verdict).toBe('mismatch');
    expect(interpret('{"shown":"tea","depicts":false,"confidence":-3}').verdict).toBe('unknown');
  });

  it('says what it saw, so a rejection is explicable', () => {
    const result = interpret('{"shown":"a garden hose","depicts":false,"confidence":0.9}');
    expect(result.shown).toBe('a garden hose');
    expect(result.reason).toContain('a garden hose');
  });
});
