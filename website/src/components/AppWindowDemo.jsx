import { useState, useEffect, useRef } from "react";
import { m as Motion, AnimatePresence, LazyMotion, domMax } from "framer-motion";
import {
  Search, Settings, Home, ChevronDown, ChevronLeft,
  Calendar as CalendarIcon, Clock, PencilLine, ArrowUp, FolderPlus,
  Inbox, MessageSquare, Building2, Users, Heart, Loader2,
  Square, Pause,
} from "lucide-react";
import { RecordingWave } from "./RecordingWave";

const SCREENS = ["notes", "generating", "summary", "chat"];
const SCREEN_MS = { notes: 5500, generating: 4000, summary: 5500, chat: 7000 };

const NOTES_TEXT =
  "- Rotate 2nd company off the eastern line\n- Resupply convoy delayed — reroute via northern road\n- Air-defence coverage gap at dawn\n- Engineers to reinforce forward positions";

const SUMMARY_INTRO =
  "The team aligned on the sector defence plan for the coming week. The 2nd company rotates off the eastern line for rest and refit, with resupply rerouted through the northern road after convoy delays. Engineers will reinforce the forward positions before the next rotation.";

const KEY_POINTS = [
  "2nd company rotates off the eastern line for rest and refit.",
  "Resupply convoy rerouted via the northern road after delays.",
  "Air-defence coverage gap at dawn flagged for immediate cover.",
];

const ACTION_ITEMS = [
  "Kovalenko to confirm the northern resupply route by 06:00.",
  "Engineering team to reinforce forward positions before rotation.",
];

const CHAT_Q = "What were the key defensive decisions?";
const CHAT_A =
  "The 2nd company will rotate off the eastern line for refit, and resupply is rerouted via the northern road. Kovalenko is actioned to confirm the route by 06:00, and engineers will reinforce the forward positions before the next rotation.";

function fmt(s) {
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
}

// ─── Sidebar ──────────────────────────────────────────────────────

function NavRow({ icon, label, count, active }) {
  return (
    <div
      className="flex items-center gap-2 rounded-[6px] mb-px cursor-default"
      style={{
        padding: "4px 8px",
        background: active ? "var(--surface-raised)" : "transparent",
        boxShadow: active
          ? "0 1px 2px rgba(27,27,25,0.04), 0 0 0 1px var(--border-subtle)"
          : "none",
        color: active ? "var(--fg-1)" : "var(--fg-2)",
        fontWeight: active ? 500 : 400,
        fontSize: 13,
      }}
    >
      <span style={{ flexShrink: 0 }}>{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {count != null && (
        <span style={{ fontSize: 11, color: "var(--fg-muted)", fontVariantNumeric: "tabular-nums" }}>
          {count}
        </span>
      )}
    </div>
  );
}

function AppSidebar({ activeScreen }) {
  const homeActive = activeScreen === "notes" || activeScreen === "generating";
  const chatActive = activeScreen === "chat";
  const folderActive = activeScreen === "summary";

  return (
    <div
      className="flex flex-col flex-shrink-0"
      style={{
        width: 185,
        background: "var(--surface-sunken)",
        borderRight: "1px solid var(--border-subtle)",
        overflow: "hidden",
      }}
    >
      <div className="flex items-center gap-[6px] flex-shrink-0" style={{ padding: "14px 16px 6px" }}>
        <span className="w-[10px] h-[10px] rounded-full bg-[#FF5F57] block" />
        <span className="w-[10px] h-[10px] rounded-full bg-[#FEBC2E] block" />
        <span className="w-[10px] h-[10px] rounded-full bg-[#28C840] block" />
      </div>

      <div className="flex items-center gap-[9px] px-4 pb-2.5 pt-2">
        <span style={{ display: "inline-flex", width: 22, height: 22, alignItems: "center", justifyContent: "center", color: "var(--fg-1)", flexShrink: 0 }}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 450 450" fill="none" stroke="currentColor" strokeWidth="12">
            <path d="M209.447 166.845C216.663 178.772 218.44 193.966 219.417 213.035C219.422 213.129 219.42 213.225 219.412 213.319C214.789 263.829 206.174 314.234 212.902 339.223C216.552 352.776 220.264 365.163 222.752 376.169C223.295 378.571 226.99 378.494 227.504 376.086C230.284 363.077 235.173 350.435 238.631 339.223C244.283 320.903 234.784 262.669 231.647 213.178C232.645 196.737 231.398 182.538 241.126 166.845M198.971 149.906C168.786 114.986 141.601 89.6233 93.21 90.3707C44.8194 91.1182 56.9695 115.86 74.0034 131.971C91.0372 148.081 141.627 159.331 184.18 158.423C165.298 159.389 201.563 157.91 131.124 159.87C60.7551 161.828 59.9172 224.098 127.681 209.733C127.81 209.705 127.945 209.663 128.065 209.611C168.511 192.126 188.231 177.43 218.676 143.678M231.647 125.494C278.527 72.0571 171.372 66.055 217.429 124.498C240.809 154.72 227.634 146.076 285.026 191.257C342.419 236.437 456.639 176.062 271.806 158.873C290.471 159.304 302.167 161.07 317.703 157.628C434.433 128.215 403.63 47.4569 282.532 121.508C268.291 131.274 261.97 137.712 252.35 150.155" />
          </svg>
        </span>
        <span style={{ fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: 18, letterSpacing: "-0.02em", color: "var(--fg-1)", lineHeight: 1 }}>
          StenoAI
        </span>
      </div>

      <div style={{ padding: "0 12px 10px" }}>
        <div style={{ position: "relative" }}>
          <Search size={13} style={{ position: "absolute", left: 9, top: "50%", transform: "translateY(-50%)", color: "var(--fg-2)", pointerEvents: "none" }} />
          <div style={{ height: 30, borderRadius: 6, background: "rgba(27,27,25,0.04)", color: "var(--fg-muted)", fontFamily: "var(--font-sans)", fontSize: 13, display: "flex", alignItems: "center", paddingLeft: 30, paddingRight: 8 }}>
            <span style={{ flex: 1 }}>Search</span>
            <span style={{ fontSize: 11, color: "var(--fg-muted)", background: "rgba(27,27,25,0.04)", borderRadius: 4, padding: "1px 5px", letterSpacing: "0.02em" }}>⌘K</span>
          </div>
        </div>
      </div>

      <div style={{ margin: "0 12px 4px", height: 1, background: "var(--border-subtle)", flexShrink: 0 }} />

      <div style={{ padding: "4px 8px 2px" }}>
        <NavRow icon={<Home size={14} />} label="Home" active={homeActive} />
        <NavRow icon={<Inbox size={14} />} label="All notes" count={34} />
        <NavRow icon={<MessageSquare size={14} />} label="Chat" active={chatActive} />
      </div>

      <div style={{ padding: "4px 8px" }}>
        <div className="flex items-center gap-1" style={{ padding: "4px 8px 6px", color: "var(--fg-2)", fontSize: 11.5, fontWeight: 500 }}>
          <ChevronDown size={11} />
          Folders
        </div>
        <NavRow icon={<Building2 size={14} />} label="Work" count={7} active={folderActive} />
        <NavRow icon={<Users size={14} />} label="Personal" count={5} />
        <NavRow icon={<Heart size={14} />} label="Healthcare" count={0} />
      </div>

      <div className="flex items-center mt-auto px-3 py-2.5" style={{ borderTop: "1px solid var(--border-subtle)" }}>
        <Settings size={15} style={{ color: "var(--fg-2)" }} />
      </div>
    </div>
  );
}

// ─── Shared: wave bars (used by SummaryScreen + ChatScreen) ───────

function WaveIcon() {
  const heights = [40, 70, 100, 60, 90, 50, 30];
  return (
    <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "flex-end", gap: 2, height: 12, width: 16, flexShrink: 0 }}>
      {heights.map((h, i) => (
        <span key={i} style={{ display: "block", width: 2, height: `${h}%`, background: "var(--fg-2)", borderRadius: 2 }} />
      ))}
    </span>
  );
}

// Shared positioning wrapper for all bottom pills
function BottomPill({ children }) {
  return (
    <div style={{ position: "absolute", bottom: 10, left: 0, right: 0, zIndex: 2 }}>
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "0 40px" }}>
        {children}
      </div>
    </div>
  );
}

function PillFade() {
  return (
    <div style={{
      position: "absolute", bottom: 50, left: 0, right: 0, height: 40,
      background: "linear-gradient(transparent, var(--page))",
      pointerEvents: "none", zIndex: 1,
    }} />
  );
}

// ─── Screen: Notes (Recording view) ───────────────────────────────

function NotesScreen() {
  const [typedNotes, setTypedNotes] = useState("");
  const [seconds, setSeconds] = useState(862);

  useEffect(() => {
    setTypedNotes("");
    let innerTimer = null;

    const startDelay = setTimeout(() => {
      let idx = 0;
      innerTimer = setInterval(() => {
        idx++;
        setTypedNotes(NOTES_TEXT.slice(0, idx));
        if (idx >= NOTES_TEXT.length) clearInterval(innerTimer);
      }, 28);
    }, 500);

    const ticker = setInterval(() => setSeconds((s) => s + 1), 1000);

    return () => {
      clearTimeout(startDelay);
      clearInterval(innerTimer);
      clearInterval(ticker);
    };
  }, []);

  return (
    <div className="flex-1 min-h-0 relative overflow-hidden" style={{ background: "var(--page)" }}>
      <div className="absolute inset-0 overflow-y-auto scrollbar-hide">
        <div style={{ maxWidth: 680, margin: "0 auto", padding: "28px 40px 80px" }}>
          <button className="mb-5 inline-flex items-center gap-1 border-0 bg-transparent cursor-default" style={{ fontSize: 13, color: "var(--fg-2)" }}>
            <ChevronLeft size={14} /> Home
          </button>

          <div
            style={{ fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: 34, lineHeight: 1.15, letterSpacing: "-0.02em", color: "var(--fg-1)", marginBottom: 10 }}
          >
            Frontline Defence Planning
          </div>

          <div className="flex flex-wrap items-center gap-1.5 mb-6">
            {[
              { icon: <CalendarIcon size={11} />, label: "Jun 29, 2026" },
              { icon: <Clock size={11} />, label: "Started 2:14 PM" },
            ].map((chip) => (
              <span key={chip.label} className="inline-flex items-center gap-1.5 rounded-full text-[12px]" style={{ padding: "3px 10px", background: "var(--surface-hover)", color: "var(--fg-2)" }}>
                {chip.icon} {chip.label}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5 rounded-full text-[12px]" style={{ padding: "3px 10px", color: "var(--fg-2)", border: "1px dashed var(--border-subtle)" }}>
              <FolderPlus size={11} /> Add to folder
            </span>
          </div>

          <div className="flex items-center gap-1.5 mb-2" style={{ fontSize: 13, color: "var(--fg-2)" }}>
            <PencilLine size={13} /> Notes
          </div>

          <div style={{ fontSize: 15, lineHeight: 1.6, color: "var(--fg-1)", whiteSpace: "pre-line", minHeight: 96 }}>
            {typedNotes}
            {typedNotes.length < NOTES_TEXT.length && (
              <span className="inline-block align-middle animate-pulse ml-px" style={{ width: 2, height: 15, background: "var(--fg-1)", verticalAlign: "middle" }} />
            )}
          </div>
        </div>
      </div>

      <PillFade />

      {/* Recording dock — mirrors LiveDock.tsx: centered rounded-full pill */}
      <div style={{ position: "absolute", bottom: 10, left: 0, right: 0, zIndex: 2, display: "flex", justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: "var(--surface-raised)", border: "1px solid var(--border-subtle)", borderRadius: 999, boxShadow: "var(--shadow-md)" }}>
          {/* RecordingPill: wave | label | timer */}
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "0 8px", fontSize: 13 }}>
            <RecordingWave />
            <span style={{ color: "var(--fg-2)" }}>Recording</span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--fg-1)", fontVariantNumeric: "tabular-nums" }}>
              {fmt(seconds)}
            </span>
          </span>
          {/* Transcript wave toggle */}
          <button style={{ width: 36, height: 36, borderRadius: 999, border: 0, background: "transparent", color: "var(--fg-1)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "default" }}>
            <WaveIcon />
          </button>
          {/* Pause */}
          <button style={{ width: 32, height: 32, borderRadius: 999, border: 0, background: "transparent", color: "var(--fg-1)", display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "default" }}>
            <Pause size={14} />
          </button>
          {/* Stop */}
          <button style={{ height: 32, padding: "0 12px", borderRadius: 999, border: 0, background: "var(--recording)", color: "#FFFFFF", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 500, cursor: "default" }}>
            <Square size={12} fill="currentColor" stroke="currentColor" />
            Stop
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Screen: Generating summary ───────────────────────────────────

const GENERATING_TEXT =
  "The team aligned on the sector defence plan for the week. The 2nd company rotates off the eastern line.\n\n" +
  "**Key points**\n\n" +
  "- 2nd company rotates off the eastern line for refit.\n" +
  "- Resupply rerouted via the northern road.\n" +
  "- Air-defence gap at dawn flagged for cover.\n\n" +
  "**Action items**\n\n" +
  "- Kovalenko to confirm the northern route by 06:00.";

const STAGE_LABELS = ["Analyzing transcript", "Generating notes", "Almost done…"];

function GeneratingScreen() {
  const [stage, setStage] = useState(0);
  const [streamText, setStreamText] = useState("");
  const barRef = useRef(null);
  const lastTopRef = useRef(null);

  useEffect(() => {
    setStage(0);
    setStreamText("");
    lastTopRef.current = null;

    let streamTimer = null;
    let stageTimer = null;

    const analysisDelay = setTimeout(() => {
      setStage(1);
      let idx = 0;
      streamTimer = setInterval(() => {
        idx += 5;
        setStreamText(GENERATING_TEXT.slice(0, idx));
        if (idx >= GENERATING_TEXT.length) {
          clearInterval(streamTimer);
          stageTimer = setTimeout(() => setStage(2), 300);
        }
      }, 28);
    }, 900);

    return () => {
      clearTimeout(analysisDelay);
      clearInterval(streamTimer);
      clearTimeout(stageTimer);
    };
  }, []);

  // FLIP: slide scanner bar smoothly as streamed text pushes it down
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    el.style.transition = "none";
    el.style.transform = "none";
    const newTop = el.getBoundingClientRect().top;
    const last = lastTopRef.current;
    lastTopRef.current = newTop;
    if (last === null || last === newTop) return;
    const delta = last - newTop;
    el.style.transform = `translateY(${delta}px)`;
    void el.getBoundingClientRect();
    el.style.transition = "transform 0.32s cubic-bezier(0.33, 1, 0.68, 1)";
    el.style.transform = "translateY(0)";
  }, [streamText]);

  const renderMarkdown = (text) =>
    text.split("\n").map((line, i) => {
      if (line.startsWith("**") && line.endsWith("**")) {
        return <p key={i} style={{ fontWeight: 600, fontSize: 13, color: "var(--fg-2)", letterSpacing: "0.01em", margin: "14px 0 6px", textTransform: "uppercase" }}>{line.replace(/\*\*/g, "")}</p>;
      }
      if (line.startsWith("- ")) {
        return (
          <div key={i} className="relative" style={{ paddingLeft: 14, marginBottom: 4 }}>
            <span className="absolute" style={{ left: 4, top: 9, width: 4, height: 4, borderRadius: "50%", background: "var(--fg-2)", display: "block" }} />
            <span style={{ fontSize: 14.5, lineHeight: 1.55, color: "var(--fg-1)" }}>{line.slice(2)}</span>
          </div>
        );
      }
      if (line === "") return <div key={i} style={{ height: 6 }} />;
      return <p key={i} style={{ fontSize: 15, lineHeight: 1.6, color: "var(--fg-1)", margin: "0 0 4px" }}>{line}</p>;
    });

  return (
    <div className="flex-1 min-h-0 relative overflow-hidden" style={{ background: "var(--page)" }}>
      {/* New note button — mirrors MainToolbar record-btn */}
      <button style={{ position: "absolute", top: 10, right: 12, zIndex: 3, display: "inline-flex", alignItems: "center", gap: 8, height: 30, padding: "0 14px", borderRadius: 999, background: "transparent", color: "var(--fg-1)", fontWeight: 500, fontSize: 13, border: 0, cursor: "default", fontFamily: "var(--font-sans)", boxShadow: "inset 0 0 0 1px var(--border)", letterSpacing: "-0.005em" }}>
        <PencilLine size={13} /> New note
      </button>

      <div className="absolute inset-0 overflow-y-auto scrollbar-hide">
        <div style={{ maxWidth: 680, margin: "0 auto", padding: "28px 40px 110px" }}>
          <button className="mb-5 inline-flex items-center gap-1 border-0 bg-transparent cursor-default" style={{ fontSize: 13, color: "var(--fg-2)" }}>
            <ChevronLeft size={14} /> Home
          </button>

          <div style={{ fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: 34, lineHeight: 1.15, letterSpacing: "-0.02em", color: "var(--fg-1)", margin: "0 0 10px" }}>
            Frontline Defence Planning
          </div>

          <div className="flex flex-wrap items-center gap-1.5 mb-6">
            {[
              { icon: <CalendarIcon size={11} />, label: "Jun 29, 2026" },
              { icon: <Clock size={11} />, label: "14 min" },
            ].map((chip) => (
              <span key={chip.label} className="inline-flex items-center gap-1.5 rounded-full text-[12px]" style={{ padding: "3px 10px", background: "var(--surface-hover)", color: "var(--fg-2)" }}>
                {chip.icon} {chip.label}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ padding: "3px 8px", color: "var(--fg-2)", background: "var(--surface-sunken)", borderRadius: 6 }}>
              <Loader2 size={11} className="animate-spin" /> Processing
            </span>
          </div>

          {streamText && <div className="mb-3">{renderMarkdown(streamText)}</div>}
          <div
            ref={barRef}
            className="flex items-center gap-2.5 rounded-lg"
            style={{ padding: "10px 14px", background: "var(--surface-raised)", border: "1px solid var(--border-subtle)", boxShadow: "var(--shadow-md)" }}
          >
            <Loader2 size={14} className="animate-spin" style={{ color: "var(--fg-2)", flexShrink: 0 }} />
            <span style={{ fontSize: 13, color: "var(--fg-1)" }}>{STAGE_LABELS[stage]}</span>
          </div>
        </div>
      </div>

      <PillFade />

      {/* Processing dock — mirrors ProcessingDock.tsx: centered rounded-full */}
      <div style={{ position: "absolute", bottom: 10, left: 0, right: 0, zIndex: 2, display: "flex", justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", background: "var(--surface-raised)", border: "1px solid var(--border-subtle)", borderRadius: 999, boxShadow: "var(--shadow-md)" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "0 8px", fontSize: 13 }}>
            <Loader2 size={14} className="animate-spin" style={{ color: "var(--fg-2)", flexShrink: 0 }} />
            <span style={{ color: "var(--fg-2)" }}>Processing</span>
            <span style={{ color: "var(--fg-1)", fontFamily: "var(--font-sans)", fontSize: 13 }}>14 min</span>
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Screen: Summary (MeetingDetail view) ─────────────────────────

function SummaryScreen() {
  return (
    <div className="flex-1 min-h-0 relative overflow-hidden" style={{ background: "var(--page)" }}>
      <button style={{ position: "absolute", top: 10, right: 12, zIndex: 3, display: "inline-flex", alignItems: "center", gap: 8, height: 30, padding: "0 14px", borderRadius: 999, background: "transparent", color: "var(--fg-1)", fontWeight: 500, fontSize: 13, border: 0, cursor: "default", fontFamily: "var(--font-sans)", boxShadow: "inset 0 0 0 1px var(--border)", letterSpacing: "-0.005em" }}>
        <PencilLine size={13} /> New note
      </button>
      <div className="absolute inset-0 overflow-y-auto scrollbar-hide">
        <div style={{ maxWidth: 680, margin: "0 auto", padding: "28px 40px 80px" }}>
          <button className="mb-4 inline-flex items-center gap-1 border-0 bg-transparent cursor-default" style={{ fontSize: 12.5, color: "var(--fg-2)" }}>
            <ChevronLeft size={14} /> All meetings
          </button>

          <div style={{ fontFamily: "var(--font-serif)", fontWeight: 400, fontSize: 36, lineHeight: 1.1, letterSpacing: "-0.025em", color: "var(--fg-1)", margin: "0 0 10px" }}>
            Frontline Defence Planning
          </div>

          <div className="flex flex-wrap items-center gap-1.5 pb-5 mb-5" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
            {[
              { icon: <CalendarIcon size={11} />, label: "Jun 29, 2026" },
              { icon: <Clock size={11} />, label: "28 min" },
            ].map((chip) => (
              <span key={chip.label} className="inline-flex items-center gap-1.5 rounded-full text-[12px]" style={{ padding: "3px 10px", background: "var(--surface-hover)", color: "var(--fg-2)" }}>
                {chip.icon} {chip.label}
              </span>
            ))}
          </div>

          <p style={{ fontSize: 15.5, lineHeight: 1.65, color: "var(--fg-1)", margin: "0 0 20px", maxWidth: "64ch" }}>
            {SUMMARY_INTRO}
          </p>

          <div className="mb-5">
            <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.01em", color: "var(--fg-2)", margin: "0 0 10px", fontFamily: "var(--font-sans)" }}>KEY POINTS</div>
            <ul className="list-none p-0 m-0 space-y-2">
              {KEY_POINTS.map((pt) => (
                <li key={pt} className="relative pl-[18px]" style={{ fontSize: 14.5, lineHeight: 1.55, color: "var(--fg-1)" }}>
                  <span className="absolute rounded-full" style={{ left: 4, top: 9, width: 4, height: 4, background: "var(--fg-2)" }} />
                  {pt}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.01em", color: "var(--fg-2)", margin: "0 0 10px", fontFamily: "var(--font-sans)" }}>ACTION ITEMS</div>
            <ul className="list-none p-0 m-0 space-y-2">
              {ACTION_ITEMS.map((ai) => (
                <li key={ai} className="relative pl-[18px]" style={{ fontSize: 14.5, lineHeight: 1.55, color: "var(--fg-1)" }}>
                  <span className="absolute rounded-full" style={{ left: 4, top: 9, width: 4, height: 4, background: "var(--fg-2)" }} />
                  {ai}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      <PillFade />

      <BottomPill>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 8px 8px 12px", background: "var(--surface-raised)", border: "1px solid var(--border-subtle)", borderRadius: 14, boxShadow: "var(--shadow-sm)" }}>
          <WaveIcon />
          <div style={{ flex: 1, fontSize: 14, fontWeight: 500, color: "var(--fg-2)" }}>
            Ask anything about this meeting…
          </div>
          <button style={{ width: 30, height: 30, borderRadius: 999, border: 0, background: "var(--surface-active)", color: "var(--fg-2)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "default" }}>
            <ArrowUp size={14} />
          </button>
        </div>
      </BottomPill>
    </div>
  );
}

// ─── Screen: Chat ─────────────────────────────────────────────────

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 0.2, 0.4].map((delay, i) => (
        <span key={i} style={{ display: "inline-block", width: 5, height: 5, borderRadius: "50%", background: "var(--fg-2)", animation: `thinkingBounce 1.2s ease-in-out ${delay}s infinite` }} />
      ))}
    </div>
  );
}

function ChatScreen() {
  const [inputText, setInputText] = useState("");
  const [phase, setPhase] = useState(0);
  const [typedA, setTypedA] = useState("");

  useEffect(() => {
    setInputText("");
    setPhase(0);
    setTypedA("");

    let qTimer = null;
    let pauseHandle = null;
    let thinkHandle = null;
    let aTimer = null;

    const startDelay = setTimeout(() => {
      let qIdx = 0;
      qTimer = setInterval(() => {
        qIdx++;
        setInputText(CHAT_Q.slice(0, qIdx));
        if (qIdx >= CHAT_Q.length) {
          clearInterval(qTimer);
          pauseHandle = setTimeout(() => {
            setInputText("");
            setPhase(1);
            thinkHandle = setTimeout(() => {
              setPhase(2);
              let aIdx = 0;
              aTimer = setInterval(() => {
                aIdx++;
                setTypedA(CHAT_A.slice(0, aIdx));
                if (aIdx >= CHAT_A.length) clearInterval(aTimer);
              }, 15);
            }, 700);
          }, 400);
        }
      }, 38);
    }, 300);

    return () => {
      clearTimeout(startDelay);
      clearInterval(qTimer);
      clearTimeout(pauseHandle);
      clearTimeout(thinkHandle);
      clearInterval(aTimer);
    };
  }, []);

  const showPanel = phase >= 1;

  return (
    <div className="flex-1 min-h-0 relative overflow-hidden" style={{ background: "var(--page)", textAlign: "left" }}>
      {/* Faded meeting content — shows notes visible behind the chat panel */}
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "20px 40px", opacity: 0.3, pointerEvents: "none", userSelect: "none" }}>
        <div style={{ fontSize: 13, color: "var(--fg-2)", marginBottom: 10, display: "flex", alignItems: "center", gap: 3 }}>
          <ChevronLeft size={13} /> Work
        </div>
        <div style={{ fontFamily: "var(--font-serif)", fontSize: 30, fontWeight: 400, letterSpacing: "-0.02em", color: "var(--fg-1)", marginBottom: 10 }}>
          Frontline Defence Planning
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 16 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", background: "var(--surface-hover)", borderRadius: 20, fontSize: 12, color: "var(--fg-2)" }}>
            <CalendarIcon size={11} /> Jun 29, 2026
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", background: "var(--surface-hover)", borderRadius: 20, fontSize: 12, color: "var(--fg-2)" }}>
            <Clock size={11} /> 2:14 PM
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--fg-2)", marginBottom: 8 }}>
          <PencilLine size={13} /> Notes
        </div>
        <div style={{ fontSize: 14, lineHeight: 1.6, color: "var(--fg-1)", whiteSpace: "pre-line" }}>
          {NOTES_TEXT}
        </div>
      </div>

      {/* Gradient fade above dock */}
      <div style={{ position: "absolute", bottom: showPanel ? 230 : 72, left: 0, right: 0, height: 80, background: "linear-gradient(transparent, var(--page))", pointerEvents: "none", transition: "bottom 0.25s ease", zIndex: 1 }} />

      {/* Dock */}
      <div style={{ position: "absolute", bottom: 10, left: 0, right: 0, zIndex: 2 }}>
        <div style={{ maxWidth: 680, margin: "0 auto", padding: "0 40px", display: "flex", flexDirection: "column", gap: 6 }}>

          <AnimatePresence>
          {showPanel && (
            <Motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.22, ease: [0.33, 1, 0.68, 1] }}
            >
            <div style={{ background: "color-mix(in srgb, var(--surface-raised) 92%, transparent)", backdropFilter: "saturate(160%) blur(10px)", WebkitBackdropFilter: "saturate(160%) blur(10px)", border: "1px solid var(--border-subtle)", borderRadius: 14, boxShadow: "var(--shadow-md)", overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border-subtle)" }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--fg-1)", flex: 1 }}>
                  Frontline Defence Planning
                  <ChevronDown size={11} style={{ display: "inline", marginLeft: 3, color: "var(--fg-2)", verticalAlign: "middle" }} />
                </span>
                <button style={{ border: "1px solid var(--border-subtle)", borderRadius: 6, padding: "2px 8px", fontSize: 12, color: "var(--fg-2)", background: "transparent", cursor: "default" }}>
                  New chat
                </button>
              </div>
              <div className="scrollbar-hide overflow-y-auto" style={{ padding: "10px 14px 12px", maxHeight: 150 }}>
                <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
                  <div style={{ background: "var(--surface-hover)", border: "1px solid var(--border-subtle)", borderRadius: "18px 18px 4px 18px", padding: "7px 12px", fontSize: 14, color: "var(--fg-1)", maxWidth: "75%", lineHeight: 1.5 }}>
                    {CHAT_Q}
                  </div>
                </div>
                {phase === 1 && <ThinkingDots />}
                {phase >= 2 && (
                  <div style={{ fontSize: 14, lineHeight: 1.7, color: "var(--fg-1)" }}>
                    {typedA}
                  </div>
                )}
              </div>
            </div>
            </Motion.div>
          )}
          </AnimatePresence>

          {/* Input pill */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 8px 8px 12px", background: "var(--surface-raised)", border: "1px solid var(--border-subtle)", borderRadius: 14, boxShadow: "var(--shadow-sm)" }}>
            <button style={{ width: 30, height: 30, borderRadius: 8, border: 0, background: "transparent", color: "var(--fg-2)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "default" }}>
              <WaveIcon />
            </button>
            <div style={{ flex: 1, minWidth: 0, height: 32, display: "flex", alignItems: "center", fontSize: 14, fontWeight: 500, color: inputText ? "var(--fg-1)" : "var(--fg-2)", overflow: "hidden", whiteSpace: "nowrap" }}>
              {inputText || (showPanel ? "Continue chat…" : "Ask anything about this meeting…")}
              {phase === 0 && inputText.length > 0 && inputText.length < CHAT_Q.length && (
                <span style={{ display: "inline-block", width: 2, height: 14, background: "var(--fg-1)", marginLeft: 1, verticalAlign: "middle" }} />
              )}
            </div>
            <button style={{ width: 30, height: 30, borderRadius: 999, border: 0, background: inputText ? "var(--fg-1)" : "var(--surface-active)", color: inputText ? "var(--fg-inverse)" : "var(--fg-2)", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "default" }}>
              <ArrowUp size={14} />
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────

// Window is built at a native 680×480 reference size (matching Features.jsx's
// ScaledApp convention). On containers narrower than that — phones — it
// scales down as a unit via a CSS transform so the sidebar/text/spacing
// shrink together instead of the sidebar just eating a bigger share of a
// squeezed flex row. Containers at or above the reference width (desktop)
// get scale clamped to 1 and render with the original unscaled, fluid-width
// layout untouched.
const NATIVE_W = 680;
const NATIVE_H = 480;

export function AppWindowDemo() {
  const [screenIdx, setScreenIdx] = useState(0);
  const screen = SCREENS[screenIdx];
  const outerRef = useRef(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const ms = SCREEN_MS[screen] ?? 8000;
    const t = setTimeout(() => setScreenIdx((i) => (i + 1) % SCREENS.length), ms);
    return () => clearTimeout(t);
  }, [screen]);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    const measure = () => {
      const s = Math.min(1, el.offsetWidth / NATIVE_W);
      if (!s) return; // transient 0-width measurement (e.g. bfcache restore) — skip, keep last good scale
      setScale(s);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <LazyMotion features={domMax} strict={false}>
    <div aria-hidden="true" inert className="relative max-w-full" style={{ padding: "2px 2px 32px", textAlign: "left", pointerEvents: "none", userSelect: "none" }}>
      <div
        ref={outerRef}
        className="rounded-[14px] overflow-hidden"
        style={{
          background: "var(--surface-raised)",
          boxShadow: "var(--shadow-demo)",
          border: "1px solid var(--border)",
          height: NATIVE_H * scale,
        }}
      >
        <div
          className="flex"
          style={{
            width: scale < 1 ? NATIVE_W : "100%",
            height: NATIVE_H,
            transform: scale < 1 ? `scale(${scale})` : "none",
            transformOrigin: "top left",
          }}
        >
          <AppSidebar activeScreen={screen} />
          <div className="flex-1 min-w-0 overflow-hidden relative">
            <div className="absolute inset-0 flex flex-col">
              {screen === "notes" && <NotesScreen />}
              {screen === "generating" && <GeneratingScreen />}
              {screen === "summary" && <SummaryScreen />}
              {screen === "chat" && <ChatScreen />}
            </div>
          </div>
        </div>
      </div>
    </div>
    </LazyMotion>
  );
}
