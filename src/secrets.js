'use strict';
// Credenciales de exchanges cifradas en reposo (AES-256-GCM).
// Clave: variable de entorno ARBITRACK_SECRET (recomendado) o data/.key generado automáticamente (permisos 600).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const deriveKey = (secret) => crypto.createHash('sha256').update(secret).digest();

// `aad` liga el texto cifrado a su dueño: una caja copiada a otro usuario no se descifra.
function encryptBox(key, obj, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) c.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function decryptBox(key, box, aad) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  if (aad) d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8'));
}

class Secrets {
  /** `opts.secret`: clave explícita; `null` fuerza el archivo data/.key aunque exista ARBITRACK_SECRET. */
  constructor(dir, opts = {}) {
    this.file = path.join(dir, 'credentials.enc.json');
    this.legacyFile = path.join(dir, 'credentials.json');
    const envSecret = opts.secret !== undefined ? opts.secret : process.env.ARBITRACK_SECRET;
    if (envSecret) {
      this.key = deriveKey(envSecret);
      this.keySource = 'env';
    } else {
      const kf = path.join(dir, '.key');
      if (!fs.existsSync(kf)) fs.writeFileSync(kf, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
      this.key = Buffer.from(fs.readFileSync(kf, 'utf8').trim(), 'hex');
      this.keySource = 'file';
    }
    this.migrateLegacy();
  }

  encrypt(obj) { return encryptBox(this.key, obj); }
  decrypt(box) { return decryptBox(this.key, box); }

  all() {
    if (!fs.existsSync(this.file)) return {};
    try { return this.decrypt(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch (e) {
      throw new Error('No se pudieron descifrar las credenciales (¿cambió ARBITRACK_SECRET?). Vuelva a conectar los exchanges.');
    }
  }

  saveAll(obj) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.encrypt(obj)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  get(name) { return this.all()[name] || null; }
  set(name, cred) { const a = this.all(); a[name] = cred; this.saveAll(a); }
  remove(name) { const a = this.all(); delete a[name]; this.saveAll(a); }

  /** Credenciales en texto plano del backend antiguo → cifradas; el archivo plano se elimina. */
  migrateLegacy() {
    if (!fs.existsSync(this.legacyFile)) return;
    try {
      const old = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8'));
      this.saveAll({ ...this.all(), ...old });
      fs.unlinkSync(this.legacyFile);
    } catch { /* se deja el archivo si no se puede leer */ }
  }
}

const mask = (s) => (s ? `${String(s).slice(0, 4)}…${String(s).slice(-4)}` : null);

module.exports = { Secrets, mask, deriveKey, encryptBox, decryptBox };
