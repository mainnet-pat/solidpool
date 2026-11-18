// Byte helpers shared by the verifier runtime. Uint8Array only: no Node buffer type and no Node globals.
export const utf8 = (text) => new TextEncoder().encode(text);

export const alloc = (length, value = 0) => {
  const bytes = new Uint8Array(length);
  if (value !== 0) bytes.fill(value);
  return bytes;
};

export const concat = (parts) => {
  let length = 0;
  for (const part of parts) length += part.length;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
};

export const fromHex = (hex) => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};

export const toHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
