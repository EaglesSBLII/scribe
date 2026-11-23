/**
 * Brings microphone audio to the rate Whisper needs. Most browsers can record
 * at that rate directly; on those that cannot (some phones), each output
 * sample is the average of the input samples it covers.
 */
export function makeResampler(inRate: number, outRate = 16000): (input: Float32Array) => Float32Array {
  if (inRate === outRate) return (input) => input;
  const step = inRate / outRate;
  let carry = new Float32Array(0);
  let pos = 0;
  return (input) => {
    const all = new Float32Array(carry.length + input.length);
    all.set(carry);
    all.set(input, carry.length);
    const out: number[] = [];
    while (pos + step <= all.length) {
      const from = Math.floor(pos);
      const to = Math.max(from + 1, Math.floor(pos + step));
      let sum = 0;
      for (let i = from; i < to; i++) sum += all[i];
      out.push(sum / (to - from));
      pos += step;
    }
    const used = Math.floor(pos);
    carry = all.slice(used);
    pos -= used;
    return Float32Array.from(out);
  };
}
