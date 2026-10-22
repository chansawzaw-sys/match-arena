'use strict';
// AES-256-GCM encryption for secrets stored in the database (TOTP secrets).
// Format: base64(iv):base64(authTag):base64(ciphertext). No secret is stored
// in plaintext, and the key itself is never written to a file by this code.
const crypto = require('crypto');

function encryptText(plainText, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ciphertext.toString('base64')}`;
}

function decryptText(packed, key) {
  const [ivB64, tagB64, cipherB64] = String(packed).split(':');
  if (!ivB64 || !tagB64 || !cipherB64) throw new Error('Invalid encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(cipherB64, 'base64')), decipher.final()]).toString('utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

module.exports = { encryptText, decryptText, sha256 };
