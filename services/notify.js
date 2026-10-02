// In-app notifications, optionally also sent by email.
//
// Email uses SMTP settings from .env (SMTP_HOST, SMTP_PORT, SMTP_SECURE,
// SMTP_USER, SMTP_PASS, SMTP_FROM). When SMTP isn't configured the in-app
// notification is still created and a warning is logged once — the portal
// keeps working, people just don't get the email.

const nodemailer = require('nodemailer');
const prisma = require('../prismaClient');

let transporter = null;
let warnedNoSmtp = false;

// The latest email attempt, for the System status page (in memory; resets
// when the service restarts).
const emailHealth = { lastAttemptAt: null, lastOkAt: null, lastError: null, lastErrorAt: null };
function recordEmail(ok, err) {
  const now = new Date();
  emailHealth.lastAttemptAt = now;
  if (ok) { emailHealth.lastOkAt = now; emailHealth.lastError = null; emailHealth.lastErrorAt = null; }
  else { emailHealth.lastError = err?.message || String(err); emailHealth.lastErrorAt = now; }
}

function getTransporter() {
  if (!process.env.SMTP_HOST) {
    if (!warnedNoSmtp) {
      console.warn('SMTP_HOST not set — notification emails are disabled (in-app notifications still work).');
      warnedNoSmtp = true;
    }
    return null;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT, 10) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    });
  }
  return transporter;
}

function absoluteLink(link) {
  if (!link) return '';
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  return base ? `${base}${link}` : link;
}

// Notifies each user in-app, and by email when `email` is true.
//   users — PortalUser rows (need id, email, active)
async function notifyUsers(users, { type, title, body, link = null, email = false }) {
  const recipients = users.filter((u) => u.active);
  const mailer = email ? getTransporter() : null;

  for (const user of recipients) {
    const notification = await prisma.notification.create({
      data: { userId: user.id, type, title, body, link }
    });

    if (!mailer || !user.email) continue;
    try {
      const url = absoluteLink(link);
      await mailer.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: user.email,
        subject: `[Casuals Portal] ${title}`,
        text: `${body}${url ? `\n\nOpen in the portal: ${url}` : ''}`
      });
      recordEmail(true);
      await prisma.notification.update({ where: { id: notification.id }, data: { emailedAt: new Date() } });
    } catch (err) {
      // An email failure must not stop the in-app notification or the job
      // that raised it.
      recordEmail(false, err);
      console.error(`Notification email to ${user.email} failed:`, err.message);
    }
  }
  return recipients.length;
}

async function usersWithRoles(roles, subcontractorName) {
  return prisma.portalUser.findMany({ where: { role: { in: roles }, active: true, subcontractorName } });
}

// Emails someone the temporary password HR / a System Admin just set for
// them — on a new account (kind 'created') or a reset ('reset'). It's
// one-time: the portal makes them choose their own at sign-in. Never
// throws; returns { sent, error } so the caller can tell HR to share the
// details another way if it didn't go.
async function sendAccountEmail({ kind, email, name, password }) {
  const mailer = getTransporter();
  if (!mailer) return { sent: false, error: 'email is not set up on the server' };

  const portalUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const intro = kind === 'reset'
    ? 'Your password for the UCAA-Ark Group Casuals Management System has been reset.'
    : 'An account has been created for you on the UCAA-Ark Group Casuals Management System.';
  const text = [
    `Hello${name ? ` ${name}` : ''},`,
    '',
    intro,
    '',
    `Sign in at:          ${portalUrl || '(ask HR for the portal address)'}`,
    `Email:               ${email}`,
    `Temporary password:  ${password}`,
    '',
    'This password is for your first sign-in only. You will be asked to choose your own straight away:',
    'at least 8 characters, with an uppercase letter, a lowercase letter and a special character.',
    '',
    'If you were not expecting this email, contact HR.'
  ].join('\n');

  try {
    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: email,
      subject: kind === 'reset' ? '[Casuals Portal] Your password has been reset' : '[Casuals Portal] Your new account',
      text
    });
    recordEmail(true);
    return { sent: true };
  } catch (err) {
    recordEmail(false, err);
    console.error(`Account email to ${email} failed:`, err.message);
    return { sent: false, error: err.message };
  }
}

module.exports = { notifyUsers, usersWithRoles, sendAccountEmail, emailHealth };
