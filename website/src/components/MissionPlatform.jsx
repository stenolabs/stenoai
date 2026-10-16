import { useRef, useState } from 'react';
import { ArrowDown, ArrowUpRight, AudioLines, Check, FileText, HardDrive, MessageSquare, Mic, Search } from 'lucide-react';
import { StenoMark } from './Brand';

const STEPS = [
  { id: 'capture', label: 'Capture the conversation.', description: 'Record microphone and system audio directly. In the room or on a call, without a meeting bot.', icon: Mic },
  { id: 'transcribe', label: 'Make every word useful.', description: 'Turn audio into a searchable transcript on your device. Follow the conversation as it happens.', icon: AudioLines },
  { id: 'summarise', label: 'Bring decisions into focus.', description: 'A model on the device, or on a server you run, turns the transcript into a clear summary, key decisions and action items.', icon: FileText },
  { id: 'ask', label: 'Put your knowledge to work.', description: 'Ask questions across your notes. Find the context behind a decision, with your local AI model.', icon: MessageSquare },
];
const BARS = Array.from({ length: 65 }, (_, i) => 12 + Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.31)) * 65);

function DemoContent({ stage }) {
  if (stage === 'capture') return (
    <div className="platform-capture">
      <span className="platform-record-label"><span className="platform-record-dot" /> Capturing on this device</span>
      <div className="platform-wave" aria-hidden="true">{BARS.map((height, i) => <span key={i} style={{ height: `${height}%` }} />)}</div>
      <span className="platform-timer">00:14:32</span>
      <div className="platform-audio-sources"><span><Mic size={13} aria-hidden="true" /> Microphone</span><span><AudioLines size={13} aria-hidden="true" /> System audio</span></div>
      <p>Your meeting. No extra participant.</p>
    </div>
  );
  if (stage === 'transcribe') return (
    <div className="platform-transcript">
      <p className="platform-content-label">Transcript <span>On-device</span></p>
      <div><span className="platform-speaker">You <time>00:13:48</time></span><p>Let’s confirm the readiness review for Thursday. We need the equipment checks and the updated briefing pack.</p></div>
      <div><span className="platform-speaker">Others <time>00:14:06</time></span><p>I’ll circulate the briefing pack by Wednesday. The equipment checks are already complete.</p></div>
      <div><span className="platform-speaker">You <time>00:14:24</time></span><p>Agreed. We’ll review the outstanding actions together on Thursday morning.</p></div>
    </div>
  );
  if (stage === 'summarise') return (
    <div className="platform-summary">
      <p className="platform-content-label">Meeting summary <span>Generated locally</span></p>
      <p>The team confirmed preparations for Thursday’s readiness review. Equipment checks are complete; the briefing pack will be circulated ahead of the meeting.</p>
      <h4>Key decisions</h4>
      <p className="platform-decision"><Check size={15} aria-hidden="true" /> Readiness review confirmed for Thursday morning.</p>
      <h4>Action items</h4>
      <div className="platform-action"><span className="platform-checkbox" aria-hidden="true" />Circulate the updated briefing pack.<span>Wednesday</span></div>
      <div className="platform-action"><span className="platform-checkbox" aria-hidden="true" />Review the outstanding actions.<span>Thursday</span></div>
    </div>
  );
  return (
    <div className="platform-chat">
      <p className="platform-content-label">Ask your notes <span>Local model</span></p>
      <div className="platform-question">What needs to happen before the readiness review?</div>
      <div className="platform-answer"><StenoMark size={26} /><div><p>The <strong>updated briefing pack</strong> needs to be circulated by Wednesday. Equipment checks are already complete.</p><p>The team will review outstanding actions together on Thursday morning.</p><span className="platform-citation"><FileText size={12} aria-hidden="true" /> Operational readiness review</span></div></div>
      <p className="platform-chat-hint"><Search size={13} aria-hidden="true" /> Find the answer in your own record.</p>
    </div>
  );
}

export function MissionPlatform() {
  const [active, setActive] = useState(0);
  const tabs = useRef([]);
  const step = STEPS[active];

  function onKeyDown(event, index) {
    let next = index;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % STEPS.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index + STEPS.length - 1) % STEPS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = STEPS.length - 1;
    else return;
    event.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  }

  return (
    <section id="how" className="mission-platform mission-section" aria-labelledby="platform-heading">
      <div className="mission-wrap">
        <div className="mission-section-top"><p className="mission-eyebrow">01 / The app</p><a href="/download/?src=platform" className="mission-text-link">Try it on your device <ArrowUpRight size={15} aria-hidden="true" /></a></div>
        <div className="mission-section-heading">
          <h2 id="platform-heading">Less note-taking.<br />More situational clarity.</h2>
          <p>From the first word to the next decision. One private workflow for recording, understanding and returning to the conversations that matter.</p>
        </div>
        <div className="mission-workflow">
          <div className="mission-workflow-tabs" role="tablist" aria-label="Explore the meeting workflow" aria-orientation="vertical">
            {STEPS.map((s, i) => (
              <button key={s.id} ref={el => { tabs.current[i] = el; }} id={`workflow-tab-${s.id}`} role="tab" aria-selected={active === i} aria-controls={`workflow-panel-${s.id}`} tabIndex={active === i ? 0 : -1} onClick={() => setActive(i)} onKeyDown={event => onKeyDown(event, i)}>
                <span className="mission-workflow-number">0{i + 1}</span>
                <span><strong>{s.label}</strong><span className="mission-workflow-description">{s.description}</span></span>
                <ArrowUpRight size={17} className="workflow-tab-arrow" aria-hidden="true" />
              </button>
            ))}
          </div>
          <div className="platform-console-wrap">
            <div className="platform-console">
              <div className="platform-windowbar"><span className="platform-window-dots" aria-hidden="true"><i /><i /><i /></span><span><StenoMark size={19} /> Steno</span><span className="platform-local"><HardDrive size={11} aria-hidden="true" /> Local mode</span></div>
              <div className="platform-meeting-header"><p>Operations <span>/</span> Meeting notes</p><h3>Operational readiness review</h3><span>Thursday, 09:30 <span aria-hidden="true">·</span> Private workspace</span></div>
              {STEPS.map((s, i) => (
                <div key={s.id} id={`workflow-panel-${s.id}`} role="tabpanel" aria-labelledby={`workflow-tab-${s.id}`} tabIndex={0} hidden={active !== i} className="platform-demo-content"><DemoContent stage={s.id} /></div>
              ))}
              <div className="platform-status"><span><step.icon size={13} aria-hidden="true" /> {step.id === 'ask' ? 'Answers on-device' : `${step.id.charAt(0).toUpperCase() + step.id.slice(1)} on-device`}</span><span>Content stays here <Check size={12} aria-hidden="true" /></span></div>
            </div>
            <p className="platform-demo-caption">Illustrative product walkthrough <span>Explore the four stages <ArrowDown size={11} aria-hidden="true" /></span></p>
          </div>
        </div>
        <div className="mission-capabilities" id="features">
          <div><span className="mission-capability-value">0</span><div><h3>Meeting bots.</h3><p>Capture the room or call directly.</p></div></div>
          <div><span className="mission-capability-value">99</span><div><h3>Languages.</h3><p>With Whisper transcription.</p></div></div>
          <div><span className="mission-capability-value">MIT</span><div><h3>Open source.</h3><p>Your team can inspect every line.</p></div></div>
        </div>
      </div>
    </section>
  );
}
