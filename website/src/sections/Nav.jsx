import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight, ArrowUpRight, Ban, BookOpenText, ChevronDown, CloudOff, FileWarning, Github, Landmark, Layers, ListChecks,
  Map as MapIcon, Menu, MessageCircleQuestion, Radar, Scale, Server, ShieldCheck, Sparkles, TrendingUp, Workflow, X,
} from "lucide-react";
import { StenoMark, Wordmark } from "../components/Brand";
import { CTA_BRIEFING } from "../content/industries.data";
import { MEGA } from "../content/nav.data";

const LINKS = [
  { href: "/#how", label: "Platform" },
  { href: "/enterprise/government/", label: "Government" },
  { href: "/enterprise/defense/", label: "Defence" },
  { href: "/enterprise/law-enforcement/", label: "Law enforcement" },
  { href: "/enterprise/", label: "Enterprise" },
];

const ICONS = {
  workflow: Workflow, sparkles: Sparkles, landmark: Landmark, server: Server, "shield-check": ShieldCheck, layers: Layers,
  "list-checks": ListChecks, "trending-up": TrendingUp, "cloud-off": CloudOff, scale: Scale, "file-warning": FileWarning,
  "message-circle-question": MessageCircleQuestion, map: MapIcon, "book-open-text": BookOpenText, radar: Radar, ban: Ban,
};
const pad = (n) => String(n).padStart(2, "0");

// The page this link belongs to (sector pages and /enterprise/ by path). Platform is a section of the homepage,
// not a page, so it is never marked current.
function isCurrent(href, path) {
  if (!path || href.includes("#")) return false;
  if (href === "/enterprise/") return path === "/enterprise/" || path === "/enterprise";
  return path.startsWith(href.replace(/\/$/, ""));
}

// One extended menu: an overview card whose image follows the hovered section, the sections on that page, and a
// short readout with the briefing button. Rendered right after its link, so keyboard order stays link -> panel.
function MegaPanel({ href, m, open, loaded, onEnter, onLeave }) {
  const [layer, setLayer] = useState(0);
  useEffect(() => { if (!open) setLayer(0); }, [open]);
  const base = m.base ?? href;
  const layers = [m.overview, ...m.items];
  const tab = open ? 0 : -1;
  return (
    <div id={`mega-${m.key}`} className={`mega-panel${open ? " is-open" : ""}`} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <div className="mega-in">
        <a className="mega-feat" href={href} tabIndex={tab}>
          {layers.map((it, k) => (
            <figure className={`mega-layer${k === layer ? " is-on" : ""}`} key={k}>
              {loaded && <img src={`/images/nav/${it.img}.webp`} alt="" width="800" height="533" decoding="async" />}
              <figcaption>
                <span className="mega-fk">{k === 0 ? m.kicker : `${pad(k)} · ${it.label}`}</span>
                <span className="mega-ft">{k === 0 ? m.title : it.line}</span>
              </figcaption>
            </figure>
          ))}
          <span className="mega-scan" aria-hidden="true"></span>
          <span className="mega-tag" aria-hidden="true"><span className="mission-status-dot"></span> Illustrative scene</span>
          <span className="mega-open">{m.overview.label} <ArrowRight size={13} aria-hidden="true" /></span>
        </a>
        <div className="mega-col">
          <p className="mega-h">On this page</p>
          <ul className="mega-list" onMouseLeave={() => setLayer(0)}>
            {m.items.map((it, k) => {
              const Icon = ICONS[it.icon] ?? ArrowRight;
              return (
                <li key={it.id}>
                  <a href={`${base}#${it.id}`} className={layer === k + 1 ? "is-on" : undefined} tabIndex={tab}
                    onMouseEnter={() => setLayer(k + 1)} onFocus={() => setLayer(k + 1)}>
                    <span className="mega-ic"><Icon size={16} strokeWidth={1.6} aria-hidden="true" /></span>
                    <span className="mega-tx"><b>{it.label}</b><span>{it.line}</span></span>
                    <span className="mega-n" aria-hidden="true">{pad(k + 1)}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="mega-side">
          <p className="mega-h">Readout</p>
          <dl className="mega-ro">
            {m.readouts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
          <div className="mega-links">
            <a href="/#security" tabIndex={tab}><ShieldCheck size={15} aria-hidden="true" /> Security & control</a>
            <a href="/download/?src=nav_menu" tabIndex={tab} data-track="download" data-location="nav_menu"><ArrowUpRight size={15} aria-hidden="true" /> Download Community</a>
          </div>
          <a href={CTA_BRIEFING} className="mission-button mission-button-light mega-cta" tabIndex={tab} data-track="demo_request" data-location="nav_menu">
            Request a briefing <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        </div>
      </div>
    </div>
  );
}

export function Nav() {
  const [open, setOpen] = useState(false);
  const [mega, setMega] = useState(null);          // href of the open extended menu (desktop)
  const [loaded, setLoaded] = useState({});         // menus opened at least once: their images load from then on
  const [bar, setBar] = useState({ x: 0, w: 0, on: false });
  const [path, setPath] = useState("");
  const trigger = useRef(null);
  const header = useRef(null);
  const nav = useRef(null);
  const linkRefs = useRef({});
  const closeTimer = useRef(0);

  useEffect(() => {
    setPath(window.location.pathname);
    const mq = window.matchMedia("(min-width: 1100px)");
    const close = () => { setOpen(false); setMega(null); };
    mq.addEventListener("change", close);
    return () => mq.removeEventListener("change", close);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const onPointer = (event) => {
      if (!header.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  // Escape closes an open extended menu and returns focus to its link.
  useEffect(() => {
    if (!mega) return;
    const onKey = (event) => {
      if (event.key === "Escape") {
        const href = mega;
        setMega(null);
        linkRefs.current[href]?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mega]);

  // The hover bar: a line along the bottom of the menu bar under the hovered (or open) link. At rest it sits under
  // the current page's link, or fades out.
  const moveBar = useCallback((href) => {
    const el = linkRefs.current[href];
    const box = nav.current;
    if (!el || !box) return;
    const a = el.getBoundingClientRect(), b = box.getBoundingClientRect();
    setBar({ x: a.left - b.left, w: a.width, on: true });
  }, []);
  const restBar = useCallback(() => {
    const current = LINKS.find(({ href }) => isCurrent(href, window.location.pathname));
    if (current) moveBar(current.href);
    else setBar((s) => ({ ...s, on: false }));
  }, [moveBar]);
  useEffect(() => {
    const t = setTimeout(restBar, 60);
    window.addEventListener("resize", restBar);
    return () => { clearTimeout(t); window.removeEventListener("resize", restBar); };
  }, [restBar]);

  const desktop = () => window.matchMedia("(min-width: 1100px)").matches;
  const cancelClose = () => clearTimeout(closeTimer.current);
  const openMega = (href) => {
    cancelClose();
    moveBar(href);
    if (!desktop() || !MEGA[href]) { setMega(null); return; }
    setLoaded((s) => (s[href] ? s : { ...s, [href]: true }));
    setMega(href);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => { setMega(null); restBar(); }, 180);
  };

  return (
    <header className="mission-header" ref={header}>
      <div className="mission-utility">
        <span>Private intelligence. On your terms.</span>
        <a href="https://docs.stenoai.co">Documentation <ArrowUpRight size={11} aria-hidden="true" /></a>
      </div>
      <nav className={`mission-nav${mega ? " has-mega-open" : ""}`} aria-label="Main navigation" ref={nav}>
        <a href="/" className="mission-brand" aria-label="StenoAI home">
          <StenoMark size={38} /><Wordmark size={24} />
        </a>
        <div className="mission-nav-links" onMouseLeave={scheduleClose}>
          {LINKS.map(({ href, label }) => {
            const m = MEGA[href];
            const current = isCurrent(href, path);
            return (
              <div className="mission-nav-item" key={href}
                onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) scheduleClose(); }}>
                <a href={href} ref={(el) => { linkRefs.current[href] = el; }}
                  className={[mega === href && "is-open", current && "is-current"].filter(Boolean).join(" ") || undefined}
                  aria-current={current ? "page" : undefined}
                  {...(m ? { "aria-controls": `mega-${m.key}`, "aria-expanded": mega === href } : {})}
                  onMouseEnter={() => openMega(href)} onFocus={() => openMega(href)}>
                  {label}{m && <ChevronDown className="mission-nav-caret" size={12} aria-hidden="true" />}
                </a>
                {m && <MegaPanel href={href} m={m} open={mega === href} loaded={!!loaded[href]} onEnter={cancelClose} onLeave={scheduleClose} />}
              </div>
            );
          })}
        </div>
        <span className={`mission-nav-bar${bar.on ? " is-on" : ""}`} style={{ transform: `translateX(${bar.x}px)`, width: `${bar.w}px` }} aria-hidden="true"></span>
        <div className="mission-nav-actions">
          <a href="https://github.com/stenolabs/stenoai" className="mission-nav-github" target="_blank" rel="noopener noreferrer" aria-label="StenoAI on GitHub (opens in a new tab)" data-track="github" data-location="nav">
            <Github size={19} aria-hidden="true" />
          </a>
          <a href="/download/?src=nav" className="mission-button mission-button-outline nav-download" data-track="download" data-location="nav">
            Download Community
          </a>
          <a href={CTA_BRIEFING} className="mission-button mission-button-light nav-briefing" data-track="demo_request" data-location="nav">
            Request a briefing <ArrowUpRight size={15} aria-hidden="true" />
          </a>
          <button ref={trigger} className="mission-menu-toggle" type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="mission-mobile-menu" aria-label={open ? "Close menu" : "Open menu"}>
            {open ? <X size={24} aria-hidden="true" /> : <Menu size={24} aria-hidden="true" />}
          </button>
        </div>
        <div id="mission-mobile-menu" className="mission-mobile-menu" hidden={!open} onBlur={(event) => {
          if (!header.current?.contains(event.relatedTarget)) setOpen(false);
        }}>
          {LINKS.map(({ href, label }, index) => (
            <a href={href} key={href} onClick={() => setOpen(false)}><span>0{index + 1}</span>{label}<ArrowUpRight size={18} aria-hidden="true" /></a>
          ))}
          <a href="/#security" onClick={() => setOpen(false)}><span>06</span>Security & control<ArrowUpRight size={18} aria-hidden="true" /></a>
          <a href="/download/?src=nav" onClick={() => setOpen(false)}><span>07</span>Download Steno<ArrowUpRight size={18} aria-hidden="true" /></a>
          <a href={CTA_BRIEFING} data-track="demo_request" data-location="mobile_nav" onClick={() => setOpen(false)}><span>↗</span>Request a briefing</a>
        </div>
      </nav>
    </header>
  );
}
