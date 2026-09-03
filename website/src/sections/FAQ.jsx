import { useState } from "react";
import { Plus, Minus } from "lucide-react";
import { AnimatePresence, m as Motion, LazyMotion, domMax } from "framer-motion";

const faqs = [
  { q: "What's included for free?", a: "Unlimited local transcription and summarization. No account, no tier, no upsell. Steno is open source. You can build and run it yourself if you prefer." },
  { q: "Which AI models can I use?", a: "Five open-weight models: Llama 3.2 3B, Gemma 4 E2B, Qwen 3.5 9B, Gemma 4 12B, and GPT-OSS 20B. All run locally, on device." },
  { q: "Is my data really private?", a: "Yes. Steno makes no network requests with your meeting content, and recordings, transcripts, and summaries never leave your device. The source is open, so you can verify it yourself, or have your security team do so. (Anonymous usage telemetry is on by default and can be switched off in Settings.)" },
  { q: "Does Steno help with HIPAA, GDPR, or SOC 2 compliance?", a: "Steno processes and stores your meeting recordings, transcripts, and summaries on your device and never sends them to any server, so there's no third-party processor handling your meeting data — which removes a meaningful part of HIPAA and GDPR exposure. It doesn't hand you compliance: those frameworks also cover safeguards, agreements, and processes that stay your responsibility. We don't claim to be a 'certified' service, because there's no cloud service handling your meetings to certify. SOC 2, for example, audits a cloud vendor's controls; because Steno keeps your meetings on-device, there's no such vendor in that path. (Steno does send anonymous, opt-out usage telemetry — never your meeting content.) The source is open, so your security team can verify exactly what is and isn't sent. See the industry pages under Enterprise for government and defence specifics." },
  { q: "How accurate is the transcription?", a: "Steno uses Parakeet TDT v3 for live transcription (25 European languages) and Whisper for languages outside that set, including Chinese, Japanese, Arabic, Korean, and Hindi (99 languages total). Results depend on audio clarity — quiet rooms and good microphones produce the best outcomes." },
  { q: "What Mac do I need?", a: "Apple Silicon Mac (M1 or later) running macOS 14.4 (Sonoma) or later. The app runs comfortably on an M1 MacBook Air. Intel Macs are no longer supported as of v0.4.0 — Intel users should stay on v0.3.8." },
  { q: "Does it work with remote meetings?", a: "Yes. Steno captures system audio and microphone simultaneously. Both sides of a Zoom, Teams, or Meet call are transcribed without any bot joining the meeting." },
  { q: "Does it need an internet connection to run?", a: "No. Once the models are downloaded during first-run setup, recording, transcription, and summarization all happen offline. Steno makes no network requests with your meeting content. The app itself still checks for updates and sends anonymous usage telemetry, which you can switch off in Settings." },
  { q: "What happens to my data if I lose my laptop or uninstall the app?", a: "Recordings and transcripts are stored only in local app storage on your device — nothing is synced to a server. That means full privacy, but also no cloud backup: if the device is lost or the app is uninstalled without exporting first, that data is gone." },
  { q: "Does it identify different speakers?", a: "Yes. Steno labels who's talking with live [You] / [Others] attribution during the recording, carried through to the final transcript." },
];

const faqJsonLd = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((f) => ({
    "@type": "Question",
    name: f.q,
    acceptedAnswer: { "@type": "Answer", text: f.a },
  })),
};

export function FAQ() {
  const [open, setOpen] = useState(null);

  return (
    <LazyMotion features={domMax} strict={false}>
    <section id="faq" className="sect">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd).replace(/</g, "\\u003c") }}
      />
      <div className="container-site" style={{ maxWidth: 820 }}>
        <div className="mb-10">
          <h2
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 400,
              fontSize: "clamp(34px, 4.6vw, 52px)",
              lineHeight: 1.08,
              letterSpacing: "-0.02em",
              color: "var(--fg-1)",
            }}
          >
            Questions
          </h2>
        </div>

        <div className="flex flex-col">
          {faqs.map((f, i) => (
            <div
              key={i}
              style={{ borderTop: "1px solid var(--border-subtle)", borderBottom: i === faqs.length - 1 ? "1px solid var(--border-subtle)" : "none" }}
            >
              <button
                onClick={() => setOpen(open === i ? null : i)}
                className="w-full bg-transparent border-0 py-6 flex justify-between items-center gap-5 cursor-pointer text-left text-fg-1 text-base md:text-[17px]"
                style={{ fontFamily: "var(--font-sans)", fontWeight: 500 }}
              >
                <span>{f.q}</span>
                <span className="text-fg-2 flex-shrink-0">
                  {open === i ? <Minus size={16} aria-hidden="true" /> : <Plus size={16} aria-hidden="true" />}
                </span>
              </button>

              <AnimatePresence>
                {open === i && (
                  <Motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="overflow-hidden"
                  >
                    <p
                      className="text-fg-2 text-[15px] leading-[1.6] pb-6"
                      style={{ maxWidth: "62ch" }}
                    >
                      {f.a}
                    </p>
                  </Motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      </div>
    </section>
    </LazyMotion>
  );
}
