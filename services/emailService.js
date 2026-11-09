const nodemailer = require('nodemailer');

// Transactional email over SMTP (Resend in production — see DEPLOY_PRODUCTION.md §7).
// When SMTP isn't configured, emails are logged instead of sent so flows like password
// reset can still be exercised locally. Sending never throws to the caller.

let transporter = null;

const isEmailConfigured = () => Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

const getTransporter = () => {
  if (!transporter) {
    const port = parseInt(process.env.SMTP_PORT, 10) || 587;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
  }
  return transporter;
};

const sendEmail = async ({ to, subject, text, html }) => {
  if (!isEmailConfigured()) {
    if (process.env.NODE_ENV === 'production') {
      console.warn(`⚠️ Email not configured (SMTP_HOST/SMTP_USER/SMTP_PASS); "${subject}" to ${to} was not sent.`);
    } else {
      console.log(`📧 [email not configured] To: ${to}\nSubject: ${subject}\n\n${text}`);
    }
    return false;
  }

  try {
    await getTransporter().sendMail({
      from: process.env.EMAIL_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html
    });
    return true;
  } catch (error) {
    console.error(`Failed to send "${subject}" email to ${to}:`, error.message);
    return false;
  }
};

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, ch => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
));

const sendPasswordResetEmail = (user, resetUrl) => {
  const text = [
    `Hi ${user.name},`,
    '',
    'We received a request to reset your SchedulerRCS password. Open the link below to choose a new one:',
    '',
    resetUrl,
    '',
    'This link expires in 1 hour and can only be used once.',
    "If you didn't ask for this, you can ignore this email — your password won't change."
  ].join('\n');

  const html = `
    <p>Hi ${escapeHtml(user.name)},</p>
    <p>We received a request to reset your SchedulerRCS password.</p>
    <p><a href="${escapeHtml(resetUrl)}">Choose a new password</a></p>
    <p>This link expires in 1 hour and can only be used once.</p>
    <p>If you didn't ask for this, you can ignore this email &mdash; your password won't change.</p>
  `;

  return sendEmail({ to: user.email, subject: 'Reset your SchedulerRCS password', text, html });
};

module.exports = {
  isEmailConfigured,
  sendEmail,
  sendPasswordResetEmail
};
