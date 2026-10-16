// Interactive/animated feature-card demos that need real client JS (typed
// text simulation, ResizeObserver-driven scaling). Split out of the section
// markup so only these two cards hydrate as React islands — the rest of
// Features.astro is pure static SVG/CSS animation with no JS shipped.
import { useEffect, useRef, useState } from "react";
import { m as Motion, AnimatePresence, LazyMotion, domMax } from "framer-motion";
import { ChevronDown, ChevronLeft, Calendar as CalendarIcon, Clock, PencilLine, ArrowUp } from "lucide-react";

const APP_W = 680;

function ScaledApp({ children }) {
  const outerRef = useRef(null);
  const [scale, setScale] = useState(1);
  const [innerH, setInnerH] = useState(460);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const measure = () => {
      const s = el.offsetWidth / APP_W;
      if (!s) return;
      setScale(s);
      setInnerH(el.offsetHeight / s);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={outerRef} style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div
        style={{
          width: APP_W,
          height: innerH,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          position: "absolute",
          top: 0,
          left: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: "var(--surface-raised)",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function AppTitlebar() {
  return (
    <div
      className="flex items-center gap-[6px] flex-shrink-0"
      style={{ padding: "10px 14px", background: "var(--surface-raised)", borderBottom: "1px solid var(--border-subtle)" }}
    >
      <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#FF5F57", display: "block" }} />
      <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#FEBC2E", display: "block" }} />
      <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#28C840", display: "block" }} />
      <span style={{ marginLeft: 12, fontSize: 12, color: "var(--fg-2)", fontFamily: "var(--font-sans)" }}>Steno</span>
    </div>
  );
}

const NOTES_TEXT =
  "Marketing pilot running 3% over budget but signups ahead of plan. Decision: reallocate $40k from Q2 ops. Priya to update forecast before board review.";

function NotesPane() {
  const [typed, setTyped] = useState("");

  useEffect(() => {
    let timer = null;

    function start() {
      let idx = 0;
      setTyped("");
      timer = setInterval(() => {
        idx++;
        setTyped(NOTES_TEXT.slice(0, idx));
        if (idx >= NOTES_TEXT.length) {
          clearInterval(timer);
          timer = setTimeout(start, 2800);
        }
      }, 28);
    }

    const delay = setTimeout(start, 500);
    return () => { clearTimeout(delay); clearInterval(timer); };
  }, []);

  return (
    <div className="flex-1 min-w-0 overflow-hidden" style={{ background: "var(--page)" }}>
      <div style={{ padding: "28px 40px" }}>
        <div className="flex items-center gap-1 mb-5" style={{ fontSize: 13, color: "var(--fg-2)" }}>
          <ChevronLeft size={14} />
          Home
        </div>
        <div className="flex items-center gap-2 mb-4">
          <span className="rec-dot" />
          <span style={{ fontSize: 13, color: "var(--fg-2)", fontFamily: "var(--font-mono)" }}>
            Recording · 00:14:22
          </span>
        </div>
        <div
          style={{
            fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: 34,
            lineHeight: 1.15, letterSpacing: "-0.02em", color: "var(--fg-1)", marginBottom: 10,
          }}
        >
          Marketing Pilot Review
        </div>
        <div className="flex flex-wrap items-center gap-1.5 mb-6">
          {[
            { icon: <CalendarIcon size={11} />, label: "Jul 15, 2026" },
            { icon: <Clock size={11} />, label: "Started 10:05 AM" },
          ].map((c) => (
            <span
              key={c.label}
              className="inline-flex items-center gap-1.5 rounded-full"
              style={{ padding: "3px 10px", background: "var(--surface-hover)", color: "var(--fg-2)", fontSize: 12 }}
            >
              {c.icon}
              {c.label}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1.5 mb-2" style={{ fontSize: 13, color: "var(--fg-2)" }}>
          <PencilLine size={13} />
          Notes
        </div>
        <div style={{ fontSize: 15, lineHeight: 1.6, color: "var(--fg-1)", minHeight: 96, whiteSpace: "pre-line" }}>
          {typed}
          {typed.length < NOTES_TEXT.length && (
            <span
              className="animate-pulse"
              style={{ display: "inline-block", width: 2, height: 15, background: "var(--fg-1)", verticalAlign: "middle", marginLeft: 1 }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

const CARD_CHAT_Q = "What's the renewal risk with Acme?";
const CARD_CHAT_A =
  "Acme flagged pricing as a concern but confirmed intent to renew at the current seat count. Contract renews Aug 15 — send the updated proposal by Aug 1, highlighting the new AI features.";

function FeatureThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 0.2, 0.4].map((delay, i) => (
        <span
          key={i}
          style={{
            display: "inline-block",
            width: 5, height: 5,
            borderRadius: "50%",
            background: "var(--fg-2)",
            animation: `thinkingBounce 1.2s ease-in-out ${delay}s infinite`,
          }}
        />
      ))}
    </div>
  );
}

export function ChatWithNotesImage() {
  const [inputText, setInputText] = useState("");
  const [phase, setPhase] = useState(0); // 0=typing, 1=thinking, 2=streaming
  const [typedA, setTypedA] = useState("");

  useEffect(() => {
    let qTimer, pauseHandle, thinkHandle, aTimer, restartHandle;

    function clear() {
      clearInterval(qTimer);
      clearTimeout(pauseHandle);
      clearTimeout(thinkHandle);
      clearInterval(aTimer);
      clearTimeout(restartHandle);
    }

    function start() {
      clear();
      setInputText("");
      setPhase(0);
      setTypedA("");

      let qIdx = 0;
      qTimer = setInterval(() => {
        qIdx++;
        setInputText(CARD_CHAT_Q.slice(0, qIdx));
        if (qIdx >= CARD_CHAT_Q.length) {
          clearInterval(qTimer);
          pauseHandle = setTimeout(() => {
            setInputText("");
            setPhase(1);
            thinkHandle = setTimeout(() => {
              setPhase(2);
              let aIdx = 0;
              aTimer = setInterval(() => {
                aIdx++;
                setTypedA(CARD_CHAT_A.slice(0, aIdx));
                if (aIdx >= CARD_CHAT_A.length) {
                  clearInterval(aTimer);
                  restartHandle = setTimeout(start, 3000);
                }
              }, 30);
            }, 700);
          }, 400);
        }
      }, 38);
    }

    const initDelay = setTimeout(start, 300);
    return () => { clearTimeout(initDelay); clear(); };
  }, []);

  const showPanel = phase >= 1;

  return (
    <LazyMotion features={domMax} strict={false}>
    <div style={{ position: "relative", width: "100%", height: "100%", background: "var(--surface-raised)" }}>
      <div
        style={{
          position: "absolute",
          top: 52, left: 52, right: 52, bottom: 36,
          overflow: "hidden",
          borderRadius: 10,
          boxShadow: "0 4px 24px rgba(27,27,25,0.12), 0 1px 4px rgba(27,27,25,0.06)",
          display: "flex", flexDirection: "column",
          justifyContent: "flex-end",
          background: "var(--page)",
        }}
      >
      <div
        style={{
          position: "absolute", top: 0, left: 0, right: 0,
          opacity: 0.25, pointerEvents: "none",
          padding: "16px 20px",
        }}
      >
        <div style={{ fontSize: 10, color: "var(--fg-2)", marginBottom: 6, display: "flex", alignItems: "center", gap: 2 }}>
          <ChevronLeft size={9} /> Work
        </div>
        <div style={{ fontFamily: "var(--font-serif)", fontSize: 18, color: "var(--fg-1)", marginBottom: 8, letterSpacing: "-0.02em" }}>
          Acme Renewal Call
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {[
            { icon: <CalendarIcon size={9} />, label: "Jul 8, 2026" },
            { icon: <Clock size={9} />, label: "34 min" },
          ].map((c) => (
            <span key={c.label} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", background: "var(--surface-hover)", borderRadius: 20, fontSize: 10, color: "var(--fg-2)" }}>
              {c.icon} {c.label}
            </span>
          ))}
        </div>
      </div>

      <div
        style={{
          position: "absolute",
          bottom: showPanel ? 148 : 56,
          left: 0, right: 0, height: 64,
          background: "linear-gradient(transparent, var(--page))",
          pointerEvents: "none",
          transition: "bottom 0.25s ease",
          zIndex: 1,
        }}
      />

      <div style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: 6, position: "relative", zIndex: 2 }}>
        <AnimatePresence>
        {showPanel && (
          <Motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.22, ease: [0.33, 1, 0.68, 1] }}
            style={{
              background: "color-mix(in srgb, var(--surface-raised) 92%, transparent)",
              backdropFilter: "saturate(160%) blur(10px)",
              WebkitBackdropFilter: "saturate(160%) blur(10px)",
              border: "1px solid var(--border-subtle)",
              borderRadius: 12,
              boxShadow: "var(--shadow-md)",
              overflow: "hidden",
              height: 148,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 12px", borderBottom: "1px solid var(--border-subtle)", flexShrink: 0 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: "var(--fg-1)", flex: 1 }}>
                Acme Renewal Call
                <ChevronDown size={10} style={{ display: "inline", marginLeft: 2, color: "var(--fg-2)", verticalAlign: "middle" }} />
              </span>
              <button style={{ border: "1px solid var(--border-subtle)", borderRadius: 5, padding: "1px 7px", fontSize: 10, color: "var(--fg-2)", background: "transparent", cursor: "default" }}>
                New chat
              </button>
            </div>
            <div style={{ flex: 1, overflow: "hidden", padding: "8px 12px 10px" }}>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                <div
                  style={{
                    background: "var(--surface-hover)",
                    border: "1px solid var(--border-subtle)",
                    borderRadius: "14px 14px 3px 14px",
                    padding: "5px 10px",
                    fontSize: 12, color: "var(--fg-1)",
                    maxWidth: "80%", lineHeight: 1.4,
                  }}
                >
                  {CARD_CHAT_Q}
                </div>
              </div>
              {phase === 1 && <FeatureThinkingDots />}
              {phase >= 2 && (
                <div style={{ fontSize: 12, lineHeight: 1.65, color: "var(--fg-1)" }}>
                  {typedA}
                </div>
              )}
            </div>
          </Motion.div>
        )}
        </AnimatePresence>

        <div
          style={{
            display: "flex", alignItems: "center", gap: 6,
            padding: "6px 6px 6px 10px",
            background: "var(--surface-raised)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 12,
            boxShadow: "var(--shadow-sm)",
          }}
        >
          <div
            style={{
              flex: 1, fontSize: 12, height: 26,
              display: "flex", alignItems: "center",
              color: inputText ? "var(--fg-1)" : "var(--fg-2)",
              overflow: "hidden", whiteSpace: "nowrap",
            }}
          >
            {inputText || (showPanel ? "Continue chat…" : "Ask anything about your notes…")}
            {phase === 0 && inputText.length > 0 && inputText.length < CARD_CHAT_Q.length && (
              <span style={{ display: "inline-block", width: 2, height: 12, background: "var(--fg-1)", marginLeft: 1, verticalAlign: "middle" }} />
            )}
          </div>
          <button
            type="button"
            aria-label="Send message"
            style={{
              width: 26, height: 26, borderRadius: 999, border: 0,
              background: inputText ? "var(--fg-1)" : "var(--surface-active)",
              color: inputText ? "var(--fg-inverse)" : "var(--fg-2)",
              display: "inline-flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0, cursor: "default",
            }}
          >
            <ArrowUp size={12} />
          </button>
        </div>
      </div>
      </div>
    </div>
    </LazyMotion>
  );
}

export function AiNotepadImage() {
  return (
    <LazyMotion features={domMax} strict={false}>
    <div style={{ position: "relative", width: "100%", height: "100%", background: "var(--surface-raised)" }}>
      <div
        style={{
          position: "absolute",
          top: 52, left: 52, right: 52, bottom: 36,
          overflow: "hidden",
          borderRadius: 10,
          boxShadow: "0 4px 24px rgba(27,27,25,0.12), 0 1px 4px rgba(27,27,25,0.06)",
        }}
      >
        <ScaledApp>
          <AppTitlebar />
          <div className="flex flex-1 overflow-hidden" style={{ height: 420 }}>
            <NotesPane />
          </div>
        </ScaledApp>
      </div>
    </div>
    </LazyMotion>
  );
}
