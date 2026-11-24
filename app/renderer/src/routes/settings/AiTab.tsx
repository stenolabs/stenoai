import { t } from '@/i18n';
import { SectionHeading } from './primitives';
import { SummarisationSection } from './ai/SummarisationSection';
import { TranscriptionSection } from './ai/TranscriptionSection';

export function AiTab() {
  return (
    <section data-settings-tab="ai">
      <SectionHeading>{t('settings.ai.transcription.heading')}</SectionHeading>
      <TranscriptionSection />

      <SectionHeading>{t('settings.ai.summarisation.heading')}</SectionHeading>
      <p
        className="text-[13px] leading-[1.5]"
        style={{ color: 'var(--fg-2)', marginBottom: 4 }}
      >
        {t('settings.ai.summarisation.description')}
      </p>
      <SummarisationSection />
    </section>
  );
}
