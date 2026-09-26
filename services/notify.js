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
      await prisma.notification.update({ where: { id: notification.id }, data: { emailedAt: new Date() } });
    } catch (err) {
      // An email failure must not stop the in-app notification or the job
      // that raised it.
      console.error(`Notification email to ${user.email} failed:`, err.message);
    }
  }
  return recipients.length;
}

async function usersWithRoles(roles, subcontractorName) {
  return prisma.portalUser.findMany({ where: { role: { in: roles }, active: true, subcontractorName } });
}

module.exports = { notifyUsers, usersWithRoles };
