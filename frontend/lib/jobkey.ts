export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** jobKey = sha256hex("forkos:job:v1|" + humanHash + "|" + capability + "|" + inputHash) — same as backend jobKeyOf. */
export async function jobKeyOf(humanHash: string, capability: string, inputHash: string): Promise<string> {
  if (!/^sha256:[0-9a-f]{64}$/.test(inputHash)) throw new Error(`bad inputHash: ${inputHash}`);
  return sha256Hex(`forkos:job:v1|${humanHash}|${capability}|${inputHash}`);
}
