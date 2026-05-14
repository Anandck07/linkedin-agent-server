import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 10000
});

export const sendMail = ({ to, subject, html }) =>
  transporter.sendMail({
    from: `"LinkedIn AI Agent" <${process.env.SMTP_USER}>`,
    to,
    subject,
    html
  });
