import Link from 'next/link';

import { MARK_BARS, MARK_BARS_BOX, MARK_BAR_HEIGHT, MARK_BAR_Y } from '@/lib/brand-mark';
import { cn } from './ui';

export const COMPANY = 'UPC Scanning LLC';
export const BRAND = 'UPC Scanning';
export const DOMAIN = 'upcscanning.com';

/**
 * The mark: five barcode bars in an uneven, deliberate rhythm, set in a black
 * tile with generous margins.
 *
 * Monochrome on purpose. A single accent colour in a logo dates quickly and
 * reads as a startup; black and white reads as a brand. The bar widths are
 * irregular the way a real barcode is, but balanced so the negative space on
 * each side is identical — that symmetry is what keeps it from looking like
 * clip art at 16px.
 */
export function Logo({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        // No tile and no outline in-app: just the bars, drawn in the current
        // text colour so the mark is white on black and black on white. A
        // hairline edge around a black square reads as a sticker, not a brand.
        // The favicon keeps its tile — a browser tab has no canvas of ours to
        // sit on, so it has to carry its own.
        'flex h-8 w-8 shrink-0 items-center justify-center text-fg',
        className,
      )}
    >
      <svg
        viewBox={`${MARK_BARS_BOX.x} ${MARK_BARS_BOX.y} ${MARK_BARS_BOX.width} ${MARK_BARS_BOX.height}`}
        className="h-[78%] w-full"
        role="presentation"
      >
        {MARK_BARS.map((bar) => (
          <rect
            key={bar.x}
            x={bar.x}
            y={MARK_BAR_Y}
            width={bar.w}
            height={MARK_BAR_HEIGHT}
            rx={0.5}
            fill="currentColor"
          />
        ))}
      </svg>
    </span>
  );
}

export function Wordmark({
  href = '/',
  className,
  showText = true,
}: {
  href?: string;
  className?: string;
  showText?: boolean;
}) {
  return (
    <Link href={href} className={cn('flex items-center gap-2.5', className)}>
      <Logo />
      {showText ? (
        <span className="text-[15px] font-semibold tracking-tight text-fg">{BRAND}</span>
      ) : null}
    </Link>
  );
}
