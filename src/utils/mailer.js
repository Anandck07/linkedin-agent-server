import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465,
  secure: true,
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
