'use strict';
const crypto = require('crypto');

// Unambiguous alphabet: no 0/O, 1/I/L. 31 symbols ^ 16 chars ≈ 7.6 × 10^23 combinations.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const LENGTH = 16;

function generateCode() {
  let out = '';
  // Rejection sampling keeps the distribution uniform.
  while (out.length < LENGTH) {
    const bytes = crypto.randomBytes(32);
    for (const b of bytes) {
      if (b < 248) { // 248 = 31 * 8
        out += ALPHABET[b % 31];
        if (out.length === LENGTH) break;
      }
    }
  }
  return out;
}

// Accepts user input such as "k7np 4xqm-9twr h6cj" and returns "K7NP4XQM9TWRH6CJ".
function normalizeCode(input) {
  if (!input) return '';
  return String(input).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 64);
}

function formatCode(code) {
  if (!code) return '';
  return code.match(/.{1,4}/g).join('-');
}

function looksValid(normalized) {
  return normalized.length === LENGTH && [...normalized].every((c) => ALPHABET.includes(c));
}

module.exports = { generateCode, normalizeCode, formatCode, looksValid, ALPHABET, LENGTH };
