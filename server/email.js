import { Resend } from "resend";

function getResend() {
  if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) {
    throw new Error("Resend email is not configured.");
  }
  return new Resend(process.env.RESEND_API_KEY);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function escapeLink(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The sign-in link must use HTTP or HTTPS.");
  }
  return escapeHtml(url.href);
}

export const sendPasswordResetOtp = async (email, otp) => {
  if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) {
    throw new Error("Resend password reset email is not configured.");
  }

  const resend = getResend();
  const result = await resend.emails.send({
    from: process.env.MAIL_FROM,
    to: email,
    subject: "Your GSC Clearance Queueing System password reset code",
    html: `<p>Your password reset code is <strong>${escapeHtml(otp)}</strong>.</p><p>This code expires in 10 minutes.</p>`,
  });

  if (result.error) throw new Error(result.error.message || "Resend rejected the email.");
  return result.data;
};

export const sendPasswordChangeOtp = async (email, otp) => {
  if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) {
    throw new Error("Resend password verification email is not configured.");
  }
  const resend = getResend();
  const result = await resend.emails.send({
    from: process.env.MAIL_FROM,
    to: email,
    subject: "Verify your GSC Clearance Queueing System password change",
    html: `<p>Your password change verification code is <strong>${escapeHtml(otp)}</strong>.</p><p>This code expires in 10 minutes. If you did not request this change, you can ignore this email.</p>`,
  });
  if (result.error) throw new Error(result.error.message || "Resend rejected the email.");
  return result.data;
};

export const sendPatientRegistrationOtp = async (email, otp) => {
  if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) {
    throw new Error("Resend patient registration email is not configured.");
  }

  const resend = getResend();
  const result = await resend.emails.send({
    from: process.env.MAIL_FROM,
    to: email,
    subject: "Verify your GSC Clearance Queueing account",
    html: `<p>Your patient registration verification code is <strong>${escapeHtml(otp)}</strong>.</p><p>This code expires in 10 minutes. If you did not start this registration, you can ignore this email.</p>`,
  });

  if (result.error) throw new Error(result.error.message || "Resend rejected the email.");
  return result.data;
};

export const sendWalkInAccountInvite = async ({ email, name, temporaryPassword, loginUrl = "" }) => {
  if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) {
    throw new Error("Patient account invitation email is not configured.");
  }
  const resend = getResend();
  const signInLink = loginUrl ? `<p><a href="${escapeLink(loginUrl)}">Sign in</a></p>` : "";
  const result = await resend.emails.send({
    from: process.env.MAIL_FROM,
    to: email,
    subject: "Your Clearance Queueing System account",
    html: `<p>Hello ${escapeHtml(name)},</p><p>Your patient account is ready. Use this temporary password to sign in: <strong>${escapeHtml(temporaryPassword)}</strong></p><p>You must reset your password before accessing your account.</p>${signInLink}`,
  });
  if (result.error) throw new Error(result.error.message || "Resend rejected the invitation email.");
  return result.data;
};
