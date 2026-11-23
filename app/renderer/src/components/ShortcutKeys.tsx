import { KbdKey } from '@/components/ui/kbd';
import { acceleratorCaps } from '@/lib/accelerator';

/** A keyboard shortcut as key caps with readable names (⌃ Ctrl  ⌥ Opt  R). */
export function ShortcutKeys({
  accelerator,
  className,
}: {
  accelerator: string;
  className?: string;
}) {
  const caps = acceleratorCaps(accelerator);
  return (
    <span className={className ?? 'inline-flex items-center gap-0.5 whitespace-nowrap align-middle'}>
      {caps.map((k, i) => (
        <KbdKey key={`${k}-${i}`} className="px-1 py-px font-sans text-[10.5px]">
          {k}
        </KbdKey>
      ))}
    </span>
  );
}
