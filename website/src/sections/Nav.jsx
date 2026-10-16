import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Github, Menu, X } from "lucide-react";
import { StenoMark, Wordmark } from "../components/Brand";
import { CTA_MAILTO } from "../content/industries.data";

const LINKS = [
  { href: "/#how", label: "Platform" },
  { href: "/enterprise/government/", label: "Government" },
  { href: "/enterprise/defense/", label: "Defence" },
  { href: "/enterprise/law-enforcement/", label: "Law enforcement" },
  { href: "/enterprise/", label: "Enterprise" },
];

export function Nav() {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  const header = useRef(null);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1100px)");
    const close = () => setOpen(false);
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

  return (
    <header className="mission-header" ref={header}>
      <div className="mission-utility">
        <span>Private intelligence. On your terms.</span>
        <a href="https://docs.stenoai.co">Documentation <ArrowUpRight size={11} aria-hidden="true" /></a>
      </div>
      <nav className="mission-nav" aria-label="Main navigation">
        <a href="/" className="mission-brand" aria-label="StenoAI home">
          <StenoMark size={38} /><Wordmark size={24} />
        </a>
        <div className="mission-nav-links">
          {LINKS.map(({ href, label }) => <a href={href} key={href}>{label}</a>)}
        </div>
        <div className="mission-nav-actions">
          <a href="https://github.com/stenolabs/stenoai" className="mission-nav-github" target="_blank" rel="noopener noreferrer" aria-label="StenoAI on GitHub (opens in a new tab)" data-track="github" data-location="nav">
            <Github size={19} aria-hidden="true" />
          </a>
          <a href="/download/?src=nav" className="mission-button mission-button-outline nav-download" data-track="download" data-location="nav">
            Download Community
          </a>
          <a href={CTA_MAILTO} className="mission-button mission-button-light nav-briefing" data-track="demo_request" data-location="nav">
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
          <a href={CTA_MAILTO} data-track="demo_request" data-location="mobile_nav" onClick={() => setOpen(false)}><span>↗</span>Request a briefing</a>
        </div>
      </nav>
    </header>
  );
}
