// Outbound email behind one function so the provider can change without
// touching routes. Today: Gmail SMTP with an app password (MAIL_USER +
// MAIL_APP_PASSWORD). Later: Brevo/Postmark by swapping the transport here.
//
// Transports:
//   smtp  - real sending via smtp.gmail.com (default when MAIL_USER is set)
//   json  - append every message to MAIL_OUTBOX_FILE (sandbox / tests)
//   log   - print to stdout, send nothing (default when nothing is configured)
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const APP_URL = (process.env.APP_URL || 'https://physiodle.up.railway.app').replace(/\/$/, '');
const FROM_NAME = process.env.MAIL_FROM_NAME || 'Physiodle';
const MAIL_USER = process.env.MAIL_USER || '';
const MAIL_PASS = process.env.MAIL_APP_PASSWORD || '';
const MODE = process.env.MAIL_TRANSPORT || (MAIL_USER && MAIL_PASS ? 'smtp' : 'log');
const OUTBOX = process.env.MAIL_OUTBOX_FILE || path.join(__dirname, 'sandbox-data', 'outbox.json');

let transport = null;
if (MODE === 'smtp') {
  transport = nodemailer.createTransport({
    host: process.env.MAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.MAIL_PORT, 10) || 465,
    secure: (process.env.MAIL_SECURE || 'true') !== 'false',
    auth: { user: MAIL_USER, pass: MAIL_PASS },
    // Fail fast: a hung SMTP socket must never hold a web request open.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
}
console.log(`[mail] transport=${MODE}${MODE === 'smtp' ? ` as ${MAIL_USER}` : ''}`);

function fromAddress() {
  return `${FROM_NAME} <${MAIL_USER || 'no-reply@physiodle.local'}>`;
}

// Minimal, readable HTML. No tracking, no images.
function wrapHtml(title, bodyHtml) {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#e6f5f0;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2937">
  <div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:28px 28px 24px;border:1px solid #d1fae5">
    <div style="font-weight:800;font-size:18px;color:#0f766e;margin-bottom:12px">Physiodle</div>
    <h1 style="font-size:20px;margin:0 0 12px">${title}</h1>
    ${bodyHtml}
    <p style="font-size:12px;color:#6b7280;margin-top:28px;line-height:1.5">You're receiving this because an action was requested for your Physiodle account. If it wasn't you, ignore this email and nothing changes.<br>Physiodle, Queensland, Australia.</p>
  </div></body></html>`;
}

async function sendMail({ to, subject, text, html }) {
  const msg = { from: fromAddress(), to, subject, text, html };
  if (MODE === 'smtp') {
    const info = await transport.sendMail(msg);
    console.log(`[mail] sent to=${to} subject="${subject}" id=${info.messageId}`);
    return { ok: true, id: info.messageId };
  }
  if (MODE === 'json') {
    let box = [];
    try { box = JSON.parse(fs.readFileSync(OUTBOX, 'utf8')); } catch (e) { box = []; }
    box.push({ ...msg, at: new Date().toISOString() });
    fs.mkdirSync(path.dirname(OUTBOX), { recursive: true });
    fs.writeFileSync(OUTBOX, JSON.stringify(box, null, 2));
    return { ok: true, id: `outbox-${box.length}` };
  }
  console.log(`[mail] (not sent, transport=log) to=${to} subject=${subject}\n${text}`);
  return { ok: true, id: 'log' };
}

function sendPasswordReset({ to, username, token }) {
  const link = `${APP_URL}/?reset=${encodeURIComponent(token)}`;
  const text = `Hi ${username},\n\nSomeone (hopefully you) asked to reset the password for your Physiodle account.\n\nReset it here (link works for 30 minutes):\n${link}\n\nIf you didn't ask for this, ignore this email. Your password stays the same.\n\nPhysiodle`;
  const html = wrapHtml('Reset your password', `
    <p>Hi ${escapeHtml(username)},</p>
    <p>Someone (hopefully you) asked to reset the password for your Physiodle account.</p>
    <p style="margin:20px 0"><a href="${link}" style="background:#0d9488;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700;display:inline-block">Choose a new password</a></p>
    <p style="font-size:13px;color:#6b7280">The link works for 30 minutes. If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all">${link}</span></p>`);
  return sendMail({ to, subject: 'Reset your Physiodle password', text, html });
}

function sendEmailConfirmation({ to, username, token }) {
  const link = `${APP_URL}/api/auth/confirm?token=${encodeURIComponent(token)}`;
  const text = `Hi ${username},\n\nConfirm this is your email address so you can reset your password if you ever forget it:\n${link}\n\nPhysiodle`;
  const html = wrapHtml('Confirm your email', `
    <p>Hi ${escapeHtml(username)},</p>
    <p>One tap confirms this is your address, so you can reset your password if you ever forget it.</p>
    <p style="margin:20px 0"><a href="${link}" style="background:#0d9488;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:700;display:inline-block">Confirm email</a></p>
    <p style="font-size:13px;color:#6b7280">If the button doesn't work, paste this into your browser:<br><span style="word-break:break-all">${link}</span></p>`);
  return sendMail({ to, subject: 'Confirm your Physiodle email', text, html });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Diagnostic: try a real send with a hard 20 s cap and report the outcome.
async function selfTest(to, override) {
  const started = Date.now();
  // Optional port/secure override so different SMTP ports can be probed
  // without redeploying (Railway may block some outbound ports).
  const port = (override && parseInt(override.port, 10)) || parseInt(process.env.MAIL_PORT, 10) || 465;
  const secure = override && override.secure != null ? override.secure === 'true' : (process.env.MAIL_SECURE || 'true') !== 'false';
  const t = override ? nodemailer.createTransport({ host: process.env.MAIL_HOST || 'smtp.gmail.com', port, secure, auth: { user: MAIL_USER, pass: MAIL_PASS }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 }) : null;
  try {
    const send = t
      ? t.sendMail({ from: fromAddress(), to, subject: `Physiodle mail test (port ${port})`, text: 'Outbound email from the server works on this port.' }).then(i => ({ id: i.messageId }))
      : sendMail({ to, subject: 'Physiodle mail test', text: 'If you can read this, outbound email from the server works.', html: '<p>If you can read this, outbound email from the server works.</p>' });
    const r = await Promise.race([
      send,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timed out after 20 s (SMTP port probably blocked or unreachable)')), 20000)),
    ]);
    return { ok: true, mode: MODE, host: process.env.MAIL_HOST || 'smtp.gmail.com', port, secure, ms: Date.now() - started, id: r.id };
  } catch (e) {
    return { ok: false, mode: MODE, host: process.env.MAIL_HOST || 'smtp.gmail.com', port, secure, ms: Date.now() - started, error: e.message, code: e.code || null, response: e.response || null };
  }
}

module.exports = { sendMail, sendPasswordReset, sendEmailConfirmation, selfTest, APP_URL, MODE };
