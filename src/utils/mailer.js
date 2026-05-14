import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

export const sendMail = ({ to, subject, html }) =>
  transporter.sendMail({
    from: `"LinkedIn AI Agent" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html
  });
