import 'dotenv/config';
import nodemailer from 'nodemailer';

// Configure SMTP Transporter with connection pooling for instant dispatch
function createTransporter() {
  const smtpHost = process.env.SMTP_HOST || process.env.EMAIL_HOST;
  const smtpPort = Number(process.env.SMTP_PORT || process.env.EMAIL_PORT || 465);
  const smtpUser = process.env.SMTP_USER || process.env.EMAIL_USER;
  const smtpPass = process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.SMTP_PASSWORD;

  if (smtpHost && smtpUser && smtpPass) {
    return nodemailer.createTransport({
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
      connectionTimeout: 8000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
    });
  }
  return null;
}

const fromEmail = process.env.SMTP_FROM || process.env.EMAIL_FROM || '"LoveWorld Singers Rehearsal Hub" <noreply@loveworldsingers.org>';

let transporter: nodemailer.Transporter | null = null;
function getTransporter() {
  if (!transporter) {
    transporter = createTransporter();
  }
  return transporter;
}

interface SendMailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail({ to, subject, html, text }: SendMailOptions): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const activeTransporter = getTransporter();
    if (activeTransporter) {
      const info = await activeTransporter.sendMail({
        from: fromEmail,
        to,
        subject,
        html,
        text: text || subject,
      });
      console.log(`[Email] Sent "${subject}" to ${to} (${info.messageId})`);
      return { success: true, messageId: info.messageId };
    } else {

      // Fallback logger for dev/staging
      console.log(`\n========================================`);
      console.log(`📧 [EMAIL SERVICE - DEV DISPATCH]`);
      console.log(`To: ${to}`);
      console.log(`Subject: ${subject}`);
      console.log(`Body:\n${text || html.replace(/<[^>]*>?/gm, '')}`);
      console.log(`========================================\n`);
      return { success: true, messageId: 'mock-dev-id' };
    }
  } catch (err: any) {
    console.error('[Email Error]:', err?.message || err);
    return { success: false, error: err?.message || 'Failed to send email' };
  }
}

/**
 * 1. Account Approved Notification
 */
export async function sendAccountApprovalEmail(to: string, name: string, zoneName?: string) {
  const subject = '🎉 Your LoveWorld Singers Account Has Been Approved!';
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 20px; overflow: hidden; border: 1px solid #e2e8f0;">
      <div style="background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%); padding: 40px 30px; text-align: center; color: #ffffff;">
        <h1 style="margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">LoveWorld Singers</h1>
        <p style="margin: 6px 0 0 0; opacity: 0.9; font-size: 14px; font-weight: 500;">Rehearsal Hub Portal</p>
      </div>
      <div style="padding: 36px 30px;">
        <div style="display: inline-block; background: #ecfdf5; border: 1px solid #a7f3d0; color: #065f46; font-size: 12px; font-weight: 700; padding: 6px 14px; rounded: 9999px; border-radius: 20px; margin-bottom: 20px;">
          ✓ Account Approved by HQ
        </div>
        <h2 style="color: #0f172a; font-size: 20px; font-weight: 800; margin: 0 0 12px 0;">Welcome, ${name}!</h2>
        <p style="color: #475569; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0;">
          Your registration for <strong>${zoneName || 'LoveWorld Singers'}</strong> has been reviewed and officially approved by HQ Administration.
        </p>
        <p style="color: #475569; font-size: 14px; line-height: 1.6; margin: 0 0 28px 0;">
          You can now log in to access the Rehearsal Hub, practice repertoire songs, view audio lab tracks, check in attendance, and collaborate with your zone.
        </p>
        <div style="text-align: center; margin-bottom: 30px;">
          <a href="https://loveworldsingers.org" style="display: inline-block; background: #7c3aed; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 14px; font-weight: 700; font-size: 14px; box-shadow: 0 4px 12px rgba(124, 58, 237, 0.3);">
            Log In to Rehearsal Hub →
          </a>
        </div>
        <p style="color: #94a3b8; font-size: 12px; text-align: center; margin: 0;">
          If you have any questions, reach out to your Zone Coordinator or HQ Support Desk.
        </p>
      </div>
    </div>
  `;
  return sendEmail({ to, subject, html });
}

/**
 * 2. 6-Digit Password Reset / Login OTP
 */
export async function sendPasswordResetOtpEmail(to: string, name: string, otpCode: string) {
  const subject = `🔐 ${otpCode} is your Password Reset Code`;
  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 20px; overflow: hidden; border: 1px solid #e2e8f0;">
      <div style="background: linear-gradient(135deg, #7c3aed 0%, #4f46e5 100%); padding: 36px 30px; text-align: center; color: #ffffff;">
        <h1 style="margin: 0; font-size: 22px; font-weight: 800;">LoveWorld Singers Security</h1>
        <p style="margin: 4px 0 0 0; opacity: 0.9; font-size: 13px;">Password Reset Request</p>
      </div>
      <div style="padding: 36px 30px; text-align: center;">
        <p style="color: #475569; font-size: 14px; margin: 0 0 20px 0;">
          Hello <strong>${name || 'Singer'}</strong>, we received a request to reset your Rehearsal Hub account password.
        </p>
        <div style="background: #f8fafc; border: 2px dashed #cbd5e1; border-radius: 16px; padding: 24px; display: inline-block; margin-bottom: 24px;">
          <p style="color: #64748b; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 8px 0;">Your Verification OTP Code</p>
          <span style="font-family: monospace; font-size: 36px; font-weight: 900; letter-spacing: 8px; color: #7c3aed;">${otpCode}</span>
        </div>
        <p style="color: #64748b; font-size: 13px; margin: 0 0 24px 0;">
          This code will expire in <strong>10 minutes</strong>. If you did not request this code, please ignore this email.
        </p>
        <hr style="border: none; border-top: 1px solid #f1f5f9; margin: 24px 0;" />
        <p style="color: #94a3b8; font-size: 11px; margin: 0;">
          LoveWorld Singers Headquarters • Rehearsal Hub Platform
        </p>
      </div>
    </div>
  `;
  return sendEmail({ to, subject, html, text: `Your Rehearsal Hub verification code is: ${otpCode}. It expires in 10 minutes.` });
}
