/**
 * Edge Sec-MS-GEC v2, using the same protocol steps as Hoshi Reader Android.
 * Based on rany2/edge-tts 7.3.1. Copyright (c) rany and contributors.
 * LGPL-3.0-or-later. See LICENSES/edge-tts.txt.
 */

export const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

const PREFIX = "Copyright (C) Microsoft Corporation. All rights reserved.";
const encoder = new TextEncoder();
let cachedTicks;
let cachedToken;

export async function secMsGec(unixSeconds) {
  const seconds = BigInt(Math.floor(unixSeconds)) + 11644473600n;
  // BigInt preserves the decimal Windows ticks used by Hoshi's Long arithmetic.
  const ticks = (seconds - seconds % 300n) * 10000000n;
  if (ticks === cachedTicks) return cachedToken;
  const data = encoder.encode(PREFIX + ticks + TRUSTED_CLIENT_TOKEN);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  const token = `${hex(cs64(data, digest))}-${hex(digest)}`;
  cachedTicks = ticks;
  cachedToken = token;
  return token;
}

function rotate16(value) {
  return (value << 16) | (value >>> 16);
}

function cs64(data, digest) {
  const keys = new DataView(digest.buffer, digest.byteOffset, digest.byteLength);
  const keyA = keys.getInt32(0, true) | 1;
  const keyB = keys.getInt32(4, true) | 1;
  const padded = new Uint8Array(Math.ceil(data.length / 8) * 8);
  padded.set(data);
  const words = new DataView(padded.buffer);
  let swapLast = 0, swapSum = 0, state = 0, sum = 0;
  for (let offset = 0; offset < padded.length; offset += 8) {
    const x = words.getInt32(offset, true);
    const y = words.getInt32(offset + 4, true);
    let q = Math.imul(rotate16((Math.imul(rotate16(x), 0xEF0569FB) +
      Math.imul(x, keyA)) | 0), 0x76F50F34);
    swapSum = (swapSum + Math.imul(rotate16(q), 0xC3EFEA97) + q) | 0;
    q = Math.imul(rotate16((Math.imul(rotate16(y), 0xC31713DB) +
      Math.imul(y, keyB)) | 0), 0x1881CE3C);
    swapLast = (Math.imul(rotate16(q), 0x35BD1EC9) + q) | 0;
    swapSum = (swapSum + swapLast) | 0;

    state = Math.imul((state + x) | 0, keyA);
    for (const factor of [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83]) {
      state = Math.imul(rotate16(state), factor);
    }
    sum = (sum + state) | 0;
    state = Math.imul((state + y) | 0, keyB);
    for (const factor of [0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69]) {
      state = Math.imul(rotate16(state), factor);
    }
    sum = (sum + state) | 0;
  }
  const result = new Uint8Array(8);
  const view = new DataView(result.buffer);
  view.setInt32(0, swapLast ^ state, true);
  view.setInt32(4, swapSum ^ sum, true);
  return result;
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}
