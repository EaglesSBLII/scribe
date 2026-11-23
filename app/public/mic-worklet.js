// Runs on the audio thread and passes raw microphone samples to the page.
class MicCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('mic-capture', MicCapture);
