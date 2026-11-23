/**
 * A small meeting point so the essay store, the microphone session and the
 * counselor panel can reach each other without importing one another.
 */

let onQuestion: ((text: string) => void) | null = null;
let voiceOn = false;

/** The microphone session says whether the writer is working by voice right now. */
export function setVoiceOn(on: boolean) {
  voiceOn = on;
}

/** True while dictating, so questions and confirmations are also spoken aloud. */
export function isVoiceOn(): boolean {
  return voiceOn;
}

/** The counselor panel registers here to receive questions asked by voice. */
export function setQuestionHandler(handler: ((text: string) => void) | null) {
  onQuestion = handler;
}

/** Send a spoken question to the counselor. Returns false when no counselor is listening. */
export function askCounselor(text: string): boolean {
  if (!onQuestion) return false;
  onQuestion(text);
  return true;
}
