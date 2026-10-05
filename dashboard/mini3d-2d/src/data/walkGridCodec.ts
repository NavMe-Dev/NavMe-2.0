/** Pack a 0/1 walk grid into a compact base64 bitmap (~8 cells per byte). */
export function packWalkGrid(walk: Uint8Array): string {
  const nbytes = Math.ceil(walk.length / 8);
  const bytes = new Uint8Array(nbytes);
  for (let i = 0; i < walk.length; i++) {
    if (walk[i]) bytes[i >> 3] |= 1 << (i & 7);
  }
  return bytesToBase64(bytes);
}

/** Restore a walk grid from a base64 bitmap produced by packWalkGrid. */
export function unpackWalkGrid(packed: string, length: number): Uint8Array {
  const bytes = base64ToBytes(packed);
  const walk = new Uint8Array(length);
  const limit = Math.min(length, bytes.length * 8);
  for (let i = 0; i < limit; i++) {
    walk[i] = (bytes[i >> 3] >> (i & 7)) & 1;
  }
  return walk;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
