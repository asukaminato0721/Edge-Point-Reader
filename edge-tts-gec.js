/**
 * Sec-MS-GEC v2, ported from rany2/edge-tts 7.3.0 src/edge_tts/drm.py.
 * Copyright (c) rany and the edge-tts contributors. LGPL-3.0-or-later.
 * Source: https://github.com/rany2/edge-tts/blob/7.3.0/src/edge_tts/drm.py
 * This JavaScript port uses 32-bit arithmetic and a single SHA-256 round loop.
 * See LICENSES/edge-tts.txt for the upstream license.
 */

export const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";

const SHA_INITIAL = [
  0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A,
  0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19,
];
const SHA_STATE = [
  0xFD9FBEA2, 0x91243CE7, 0xBE499094, 0xCD2E1E0A,
  0x6C006F49, 0x04BD35AB, 0xFEB0A7E4, 0x03EFFBD2,
];
const SHA_SCHEDULE = [
  0xEB24BF9E, 0x1558691F, 0xA0C09EE2, 0x0CFA32BA,
  0xA622EE8C, 0xD1DD9491, 0xC0DD25A0, 0xF9E70AB6,
  0xF0C31573, 0x7058CE4E, 0x7188E606, 0x00E5AB33,
  0xD258B060, 0x72766564,
];
const SHA_CONSTANTS = [
  0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5,
  0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5,
  0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3,
  0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174,
  0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC,
  0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA,
  0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7,
  0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967,
  0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13,
  0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85,
  0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3,
  0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070,
  0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5,
  0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3,
  0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208,
  0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2,
];
const CS_COEFFICIENTS = [
  [0xE82E91B1, 0xB32700D0], [0x44DE24C6, 0x88DFF51D],
  [0x3BEB65BC, 0x29514038], [0xC89C5933, 0xB328CBDF],
  [0x8D1EC211, 0xD405B4D5], [0x314EF5D5, 0x26E55F3C],
  [0xE92491B1, 0x607801C6], [0xF0A5B9D5, 0x82B2C1FB],
  [0x06064CF3, 0xFA51A3DA], [0xDA79FA60, 0x207CC464],
  [0xBED20560, 0x3C3C74F3], [0x89F9C9F8, 0xD2D14B61],
  [0x35FA38C6, 0xBB04A2C1], [0xCB49E3C6, 0xC5626167],
];
const SHA_ADJUSTMENT = 0xC9DC06A7;
const encoder = new TextEncoder();
let cachedTicks;
let cachedToken;

export function secMsGec(unixSeconds) {
  // Keep the upstream floating-point calculation. Exact BigInt ticks produce
  // different decimal strings in some windows and fail Microsoft's check.
  const windowsSeconds = unixSeconds + 11644473600;
  const ticks = ((windowsSeconds - windowsSeconds % 300) * 10000000).toFixed(0);
  if (ticks === cachedTicks) return cachedToken;
  const data = encoder.encode(ticks + TRUSTED_CLIENT_TOKEN);
  const digest = tokenSha256(data);
  const cs64 = tokenCs64(data, digest);
  cachedTicks = ticks;
  cachedToken = `${hex(cs64)}-${hex(digest)}`;
  return cachedToken;
}

function rotateRight(value, bits) {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

function rotate16(value) {
  return ((value << 16) | (value >>> 16)) >>> 0;
}

function sigma0(value) {
  return (rotateRight(value, 7) ^ rotateRight(value, 18) ^ (value >>> 3)) >>> 0;
}

function sigma1(value) {
  return (rotateRight(value, 17) ^ rotateRight(value, 19) ^ (value >>> 10)) >>> 0;
}

function expandSchedule(words, start = 16) {
  for (let i = start; i < 64; i++) {
    words[i] = (sigma1(words[i - 2]) + words[i - 7] +
      sigma0(words[i - 15]) + words[i - 16]) >>> 0;
  }
}

function shaRounds(state, words, start = 0) {
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = start; i < 64; i++) {
    const constant = start === 14 && i === 14 ? SHA_ADJUSTMENT : SHA_CONSTANTS[i];
    const t1 = (h + ((rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25)) >>> 0) +
      ((g ^ (e & (f ^ g))) >>> 0) + constant + words[i]) >>> 0;
    const t2 = (((rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22)) >>> 0) +
      (((a & b) | (c & (a | b))) >>> 0)) >>> 0;
    [a, b, c, d, e, f, g, h] = [(t1 + t2) >>> 0, a, b, c, (d + t1) >>> 0, e, f, g];
  }
  return [a, b, c, d, e, f, g, h];
}

function shaInitialState(data) {
  const words = new Uint32Array(64);
  words[14] = (data[0] << 16) | (data[1] << 8) | data[2];
  words[15] = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(3);
  for (let i = 16; i < 30; i++) {
    let value = SHA_SCHEDULE[i - 16];
    if (i - 2 >= 14) value += i === 16 ? (sigma1(words[i - 2]) ^ 0x000B92C0) >>> 0 : sigma1(words[i - 2]);
    if (i - 7 >= 14) value += words[i - 7];
    if (i - 15 >= 14) value += i === 29 ? (sigma0(words[i - 15]) ^ 0x059C0B80) >>> 0 : sigma0(words[i - 15]);
    words[i] = value >>> 0;
  }
  words[30] = (sigma1(words[28]) + words[23] + sigma0(words[15]) +
    words[14] + SHA_ADJUSTMENT - SHA_CONSTANTS[14]) >>> 0;
  expandSchedule(words, 31);
  return shaRounds(SHA_STATE, words, 14).map((word, i) => (word + SHA_INITIAL[i]) >>> 0);
}

function tokenSha256(data) {
  // Resume the modified SHA-256 state after the protocol's fixed prefix.
  const length = 57 + data.length;
  const zeros = ((55 - length) % 64 + 64) % 64;
  const padded = new Uint8Array(data.length - 7 + 1 + zeros + 8);
  padded.set(data.subarray(7));
  padded[data.length - 7] = 0x80;
  const view = new DataView(padded.buffer);
  view.setBigUint64(padded.length - 8, BigInt(length * 8));
  let state = shaInitialState(data);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(64);
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    expandSchedule(words);
    state = shaRounds(state, words).map((word, i) => (word + state[i]) >>> 0);
  }
  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  state.forEach((word, i) => digestView.setUint32(i * 4, word));
  return digest;
}

function tokenCs64(data, digest) {
  const digestView = new DataView(digest.buffer);
  const keys = [digestView.getUint32(0, true) | 1, digestView.getUint32(4, true) | 1];
  const factors = keys.map((key) => Math.imul(key, 0x82893933));
  const terms = CS_COEFFICIENTS.map(([coefficient], i) => Math.imul(coefficient, factors[i % 2]) >>> 0);
  const offsets = CS_COEFFICIENTS.map(([, offset]) => offset);
  const padded = new Uint8Array(Math.ceil((data.length + 1) / 8) * 8);
  padded.set(data, 1);
  const view = new DataView(padded.buffer);
  for (let i = 0; i < padded.length / 4; i++) {
    const word = view.getUint32(i * 4, true);
    let term = Math.imul(word, keys[i % 2]);
    let offset = Math.imul(rotate16(word), i % 2 === 0 ? 0xEF0569FB : 0xC31713DB);
    if (i === 0) {
      term += Math.imul(0xF2F90B1A, factors[0]);
      offset += 0x0B1A0000;
    }
    terms.push(term >>> 0);
    offsets.push(offset >>> 0);
  }
  let swapAcc = 0, swapLast = 0, state = 0, acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let q = Math.imul(rotate16((offsets[i] + x) >>> 0), 0x76F50F34) >>> 0;
    swapAcc = (swapAcc + Math.imul(rotate16(q), 0xC3EFEA97) + q) >>> 0;
    q = Math.imul(rotate16((offsets[i + 1] + y) >>> 0), 0x1881CE3C) >>> 0;
    swapLast = (Math.imul(rotate16(q), 0x35BD1EC9) + q) >>> 0;
    swapAcc = (swapAcc + swapLast) >>> 0;
    state = (Math.imul(state, keys[0]) + x) >>> 0;
    for (const factor of [0xCF98B111, 0x87085B9F, 0x12CEB96D, 0x257E1D83]) {
      state = Math.imul(rotate16(state), factor) >>> 0;
    }
    acc = (acc + state) >>> 0;
    state = (Math.imul(state, keys[1]) + y) >>> 0;
    for (const factor of [0xA27416F5, 0xD38396FF, 0x7C932B89, 0xBFA49F69]) {
      state = Math.imul(rotate16(state), factor) >>> 0;
    }
    acc = (acc + state) >>> 0;
  }
  const result = new Uint8Array(8);
  const resultView = new DataView(result.buffer);
  resultView.setUint32(0, (swapLast ^ state) >>> 0, true);
  resultView.setUint32(4, (swapAcc ^ acc) >>> 0, true);
  return result;
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}
