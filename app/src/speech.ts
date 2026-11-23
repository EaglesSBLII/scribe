/** Speaks results aloud with the Mac's built-in voices. Works offline. */
import { create } from 'zustand';

/** True while Scribe is talking, so the microphone can ignore Scribe's own voice. */
export const useSpeech = create<{ speaking: boolean }>(() => ({ speaking: false }));

let quietTimer: ReturnType<typeof setTimeout> | undefined;

function done() {
  // Keep ignoring the microphone for a moment so the tail of the voice is not heard.
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => useSpeech.setState({ speaking: false }), 400);
}

export function speak(text: string) {
  const synth = globalThis.speechSynthesis;
  if (!synth || !text.trim()) return;
  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  // Only voices that live on this machine; never a voice that needs the network.
  const voice = synth.getVoices().find((v) => v.localService && v.lang.startsWith('en'));
  if (voice) utterance.voice = voice;
  utterance.onend = done;
  utterance.onerror = done;
  clearTimeout(quietTimer);
  useSpeech.setState({ speaking: true });
  synth.speak(utterance);
  // If the voice never reports finishing, do not leave the microphone ignored for good.
  quietTimer = setTimeout(() => useSpeech.setState({ speaking: false }), 1500 + text.length * 90);
}

export function stopSpeaking() {
  globalThis.speechSynthesis?.cancel();
  done();
}
