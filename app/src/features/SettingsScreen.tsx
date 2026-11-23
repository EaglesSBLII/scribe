import { useEffect, useState } from 'react';
import { ArrowLeft, Play } from 'lucide-react';
import { useSettings, type CounselorMode } from '../settings';
import { platform } from '../platform';
import { speak } from '../speech';
import { setWakeWord } from '../dictation/session';
import { EARCONS, playEarcon } from '../voice/earcons';
import { useStore } from '../store';
import { forgetRemote, useSync } from '../sync';

const MODES: { id: CounselorMode; name: string; what: string }[] = [
  { id: 'draft', name: 'Draft (quiet)', what: 'Only reacts to commands and to questions you ask by name.' },
  { id: 'coach', name: 'Coach', what: 'Also speaks up briefly at natural breaks: a paragraph ends, you pause for about six seconds, or the word limit is near.' },
  { id: 'conversation', name: 'Conversation', what: 'A full back-and-forth. What you say goes to the counselor, not into the essay. This is the default while brainstorming.' },
];

function Row(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 py-2">
      <div className="min-w-0 max-w-md">
        <div className="text-sm font-medium">{props.label}</div>
        {props.hint && <div className="text-xs text-muted">{props.hint}</div>}
      </div>
      <div className="shrink-0">{props.children}</div>
    </div>
  );
}

/** Voice, counselor and sound settings. Stored on this Mac with the account. */
export function SettingsScreen() {
  const s = useSettings();
  const [models, setModels] = useState<string[]>([]);
  const [voices, setVoices] = useState<string[]>([]);
  const [voiceInstalled, setVoiceInstalled] = useState(true);

  useEffect(() => {
    void platform.llmModels().then(setModels);
    void platform.ttsInfo().then((info) => {
      setVoices(info.voices);
      setVoiceInstalled(info.available);
    });
  }, []);

  const select = 'rounded border border-line bg-white px-2 py-1 text-sm';
  const withCurrent = (list: string[], current: string) => (list.includes(current) ? list : [current, ...list]);

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-8 p-6">
        <button onClick={() => s.setScreenOpen(false)} className="flex items-center gap-1 text-sm text-accent">
          <ArrowLeft size={14} /> Back to essays
        </button>
        <h2 className="font-serif text-3xl">Settings</h2>

        <section aria-label="Wake word" className="divide-y divide-line">
          <h3 className="pb-1 font-semibold">Wake word</h3>
          <Row label="Listen for “Jarvis”" hint="Keeps the microphone open and waits for the name. Nothing said before it is kept. “Jarvis, …” while dictating is a command or question, never essay text.">
            <input type="checkbox" aria-label="Listen for Jarvis" checked={s.wakeWord} onChange={(e) => void setWakeWord(e.target.checked)} />
          </Row>
        </section>

        <section aria-label="Counselor" className="divide-y divide-line">
          <h3 className="pb-1 font-semibold">Counselor</h3>
          <div className="py-2">
            <div className="text-sm font-medium">How much it speaks up</div>
            <div role="radiogroup" aria-label="Counselor mode" className="mt-1 space-y-1">
              {MODES.map((m) => (
                <label key={m.id} className="flex cursor-pointer items-start gap-2 text-sm">
                  <input type="radio" name="mode" className="mt-1" checked={s.counselorMode === m.id} onChange={() => void s.set('counselorMode', m.id)} />
                  <span>
                    <span className="font-medium">{m.name}.</span> <span className="text-muted">{m.what}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">You can also say “Jarvis, coach mode”, “draft mode” or “conversation mode”.</p>
          </div>
          <Row label="Answer out loud" hint="Questions you ask by voice are answered by voice. Typed questions are answered in the panel only.">
            <input type="checkbox" aria-label="Answer out loud" checked={s.speakReplies} onChange={(e) => void s.set('speakReplies', e.target.checked)} />
          </Row>
          <Row label="Let me interrupt by talking" hint="Talking over the counselor stops it. If it ever cuts itself off on loud speakers, switch this off or use headphones.">
            <input type="checkbox" aria-label="Let me interrupt by talking" checked={s.bargeIn} onChange={(e) => void s.set('bargeIn', e.target.checked)} />
          </Row>
          <Row label="Voice" hint={voiceInstalled ? 'Kokoro, running on this Mac.' : 'The voice is not installed. Run ./setup.sh to add it.'}>
            <span className="flex items-center gap-2">
              <select aria-label="Voice" className={select} value={s.voice} onChange={(e) => void s.set('voice', e.target.value)}>
                {withCurrent(voices, s.voice).map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
              <button aria-label="Hear this voice" title="Hear this voice" onClick={() => speak('Hi. Tell me what happened, in your own words.')} className="rounded border border-line bg-white p-1.5">
                <Play size={14} />
              </button>
            </span>
          </Row>
          <Row label="Counselor model" hint="The larger model, for advice and grading.">
            <select aria-label="Counselor model setting" className={select} value={s.llmModel} onChange={(e) => void s.set('llmModel', e.target.value)}>
              {withCurrent(models, s.llmModel).map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Row>
          <Row label="Command model" hint="Reads spoken edit requests. It never writes essay text. A second model uses more memory.">
            <select aria-label="Command model" className={select} value={s.commandModel} onChange={(e) => void s.set('commandModel', e.target.value)}>
              <option value="">Same as counselor</option>
              {(s.commandModel ? withCurrent(models, s.commandModel) : models).map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Row>
        </section>

        <section aria-label="Sounds" className="divide-y divide-line">
          <h3 className="pb-1 font-semibold">Sounds</h3>
          <Row label="Volume" hint="Short cues made by Scribe itself. No sound files.">
            <input
              type="range"
              aria-label="Sound volume"
              min={0}
              max={1}
              step={0.05}
              value={s.earconVolume}
              onChange={(e) => void s.set('earconVolume', Number(e.target.value))}
            />
          </Row>
          {EARCONS.map((cue) => {
            const on = !s.earconsOff.includes(cue.id);
            return (
              <Row key={cue.id} label={cue.label}>
                <span className="flex items-center gap-2">
                  <button aria-label={`Play: ${cue.label}`} title="Play" onClick={() => playEarcon(cue.id, { force: true })} className="rounded border border-line bg-white p-1.5">
                    <Play size={14} />
                  </button>
                  <input
                    type="checkbox"
                    aria-label={cue.label}
                    checked={on}
                    onChange={(e) => void s.set('earconsOff', e.target.checked ? s.earconsOff.filter((x) => x !== cue.id) : [...s.earconsOff, cue.id])}
                  />
                </span>
              </Row>
            );
          })}
        </section>

        <PhoneAccess />
      </div>
    </div>
  );
}

/** On the Mac: let a phone use this Scribe. On the phone: sign out. */
function PhoneAccess() {
  const email = useStore((st) => st.account?.email ?? '');
  const remote = useSync((st) => st.remote);
  const [enabled, setEnabled] = useState(false);
  const [password, setPassword] = useState('');
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!remote && email) void platform.remoteStatus(email).then((r) => setEnabled(r.enabled)).catch(() => {});
  }, [remote, email]);

  if (remote) {
    return (
      <section aria-label="This device" className="divide-y divide-line">
        <h3 className="pb-1 font-semibold">This device</h3>
        <Row label="Signed in to your Mac" hint="Speech, the counselor and the voice all run on the Mac. Your essays are also kept here, so you can keep dictating when the Mac is out of reach. A web app cannot listen in the background on an iPhone: keep Scribe open on screen while you talk.">
          <button
            onClick={() => void platform.logout().then(() => { forgetRemote(); window.location.reload(); })}
            className="rounded border border-line bg-white px-3 py-1 text-sm"
          >
            Sign out
          </button>
        </Row>
      </section>
    );
  }

  async function turnOn() {
    setNote('');
    try {
      setEnabled((await platform.remoteSet(email, password)).enabled);
      setPassword('');
      setNote('Saved. Use this email and password to sign in on your phone.');
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'That did not work.');
    }
  }

  return (
    <section aria-label="Phone access" className="divide-y divide-line">
      <h3 className="pb-1 font-semibold">Phone access</h3>
      <Row
        label={enabled ? 'On: your phone can sign in' : 'Off'}
        hint="Lets your own phone use this Mac’s Scribe over a private connection. The Mac is never opened to the internet, and the phone must sign in with this password. See docs/phone-setup.md."
      >
        <span className="flex flex-wrap items-center gap-2">
          <input
            type="password"
            aria-label="Phone access password"
            autoComplete="new-password"
            placeholder={enabled ? 'New password' : 'Choose a password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-44 rounded border border-line bg-white px-2 py-1 text-sm"
          />
          <button onClick={() => void turnOn()} className="rounded border border-line bg-white px-3 py-1 text-sm">
            {enabled ? 'Change password' : 'Turn on'}
          </button>
          {enabled && (
            <button
              onClick={() => void platform.remoteDisable(email).then((r) => { setEnabled(r.enabled); setNote('Phone access is off. Every device was signed out.'); })}
              className="rounded border border-line bg-white px-3 py-1 text-sm text-danger"
            >
              Turn off
            </button>
          )}
        </span>
      </Row>
      {note && <p role="status" className="py-2 text-sm text-muted">{note}</p>}
    </section>
  );
}
