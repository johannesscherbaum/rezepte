let nodemailer;
try { nodemailer = require('nodemailer'); } catch(e) { nodemailer = null; }

const ENABLED = !!(nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

let transporter;
if (ENABLED) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

const FROM = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@rezepte';
const APP_URL = process.env.APP_URL || '';

const GROUP_ROLE_LABEL = {
  group_admin: 'Gruppenadmin',
  readwrite:   'Lesen & Schreiben',
  readonly:    'Nur lesen',
};

async function sendWelcomeMail({ to, username, password, groupName, groupRole }) {
  if (!ENABLED) {
    console.log(`[mailer] SMTP nicht konfiguriert – kein Willkommens-Mail an ${to}`);
    return;
  }
  const loginUrl = APP_URL || '(App-URL nicht konfiguriert)';
  const groupLine = groupName
    ? `<tr><td style="color:#666;padding:4px 0">Gruppe</td><td style="padding:4px 0"><strong>${esc(groupName)}</strong> (${esc(GROUP_ROLE_LABEL[groupRole] || groupRole)})</td></tr>`
    : '';

  const html = `
<div style="font-family:sans-serif;max-width:520px;margin:0 auto">
  <h2 style="color:#526749">Willkommen bei Rezepte 🍽️</h2>
  <p>Hallo <strong>${esc(username)}</strong>,</p>
  <p>dein Konto wurde angelegt. Hier sind deine Zugangsdaten:</p>
  <table style="border-collapse:collapse;margin:16px 0">
    <tr><td style="color:#666;padding:4px 0;padding-right:24px">Benutzername</td><td style="padding:4px 0"><strong>${esc(username)}</strong></td></tr>
    <tr><td style="color:#666;padding:4px 0;padding-right:24px">Passwort</td><td style="padding:4px 0"><strong>${esc(password)}</strong></td></tr>
    ${groupLine}
  </table>
  ${APP_URL ? `<p><a href="${APP_URL}" style="background:#526749;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;display:inline-block">Jetzt einloggen</a></p>` : ''}
  <p style="color:#888;font-size:13px;margin-top:24px">Bitte ändere dein Passwort nach dem ersten Login unter <em>Profil → Passwort ändern</em>.</p>
</div>`;

  const text = `Hallo ${username},\n\ndein Konto wurde angelegt.\n\nBenutzername: ${username}\nPasswort: ${password}${groupName ? `\nGruppe: ${groupName} (${GROUP_ROLE_LABEL[groupRole] || groupRole})` : ''}\n${APP_URL ? `\nLogin: ${APP_URL}` : ''}\n\nBitte ändere dein Passwort nach dem ersten Login.`;

  await transporter.sendMail({
    from: FROM,
    to,
    subject: 'Dein Rezepte-Konto wurde angelegt',
    text,
    html,
  });
  console.log(`[mailer] Willkommens-Mail an ${to} gesendet`);
}

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

module.exports = { sendWelcomeMail };
