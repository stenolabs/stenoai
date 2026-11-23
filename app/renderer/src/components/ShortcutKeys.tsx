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
    <span className={className ?? 'inline-flex items-center gap-1 whitespace-nowrap align-middle'}>
      {caps.map((k, i) => (
        <KbdKey key={`${k}-${i}`} className="font-sans text-[11.5px]">
          {k}
        </KbdKey>
      ))}
    </span>
  );
}
