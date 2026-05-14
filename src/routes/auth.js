import express from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import User from "../models/User.js";
import { sendMail } from "../utils/mailer.js";

const router = express.Router();

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "7d" });
const genOtp = () => Math.floor(100000 + Math.random() * 900000).toString();
const OTP_TTL = 10 * 60 * 1000;
const RESEND_AFTER = 60;
const pendingOtps = new Map();
const loginOtps = new Map();

// Send OTP for registration email verification
router.post("/send-otp", async (req, res) => {
  const email = req.body.email?.toLowerCase().trim();
  if (!email) return res.status(400).json({ message: "Email required." });
  try {
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: "Email already registered." });
    const prev = pendingOtps.get(email);
    if (prev && Date.now() - prev.sentAt < RESEND_AFTER * 1000)
      return res.status(429).json({ message: `Wait ${RESEND_AFTER}s before resending.`, resendAfterSec: RESEND_AFTER });
    const otp = genOtp();
    pendingOtps.set(email, { otp, expiry: Date.now() + OTP_TTL, sentAt: Date.now() });
    await sendMail({
      to: email,
      subject: "Your OTP - LinkedIn AI Agent",
      html: `<p>Your OTP for registration is: <strong>${otp}</strong></p><p>It expires in 10 minutes.</p>`
    });
    res.json({ message: "OTP sent.", resendAfterSec: RESEND_AFTER });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Verify OTP for registration
router.post("/verify-otp", (req, res) => {
  const email = req.body.email?.toLowerCase().trim();
  const { otp } = req.body;
  const record = pendingOtps.get(email);
  if (!record || record.otp !== otp || Date.now() > record.expiry)
    return res.status(400).json({ message: "Invalid or expired OTP." });
  record.verified = true;
  res.json({ message: "Email verified." });
});

// Send OTP for login
router.post("/send-login-otp", async (req, res) => {
  const email = req.body.email?.toLowerCase().trim();
  if (!email) return res.status(400).json({ message: "Email required." });
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "No account found with this email." });
    const prev = loginOtps.get(email);
    if (prev && Date.now() - prev.sentAt < RESEND_AFTER * 1000)
      return res.status(429).json({ message: `Wait ${RESEND_AFTER}s before resending.`, resendAfterSec: RESEND_AFTER });
    const otp = genOtp();
    loginOtps.set(email, { otp, expiry: Date.now() + OTP_TTL, sentAt: Date.now() });
    await sendMail({
      to: email,
      subject: "Your Login OTP - LinkedIn AI Agent",
      html: `<p>Your login OTP is: <strong>${otp}</strong></p><p>It expires in 10 minutes.</p>`
    });
    res.json({ message: "OTP sent.", resendAfterSec: RESEND_AFTER });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Login with OTP
router.post("/login-with-otp", async (req, res) => {
  const email = req.body.email?.toLowerCase().trim();
  const { otp } = req.body;
  const record = loginOtps.get(email);
  if (!record || record.otp !== otp || Date.now() > record.expiry)
    return res.status(400).json({ message: "Invalid or expired OTP." });
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "User not found." });
    loginOtps.delete(email);
    res.json({ token: signToken(user._id), user: { id: user._id, name: user.name, email } });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/register", async (req, res) => {
  const { name, email, password } = req.body;
  const normalEmail = email?.toLowerCase().trim();
  try {
    const record = pendingOtps.get(normalEmail);
    if (!record?.verified)
      return res.status(400).json({ error: "Email not verified. Please verify with OTP first." });
    const user = await User.create({ name, email: normalEmail, password });
    pendingOtps.delete(normalEmail);
    res.json({ token: signToken(user._id), user: { id: user._id, name, email: normalEmail } });
  } catch (err) {
    res.status(400).json({ error: err.code === 11000 ? "Email already exists" : err.message });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user || !(await user.matchPassword(password)))
      return res.status(401).json({ error: "Invalid credentials" });
    res.json({ token: signToken(user._id), user: { id: user._id, name: user.name, email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.json({ message: "If that email exists, a reset link was sent." });
    const token = crypto.randomBytes(32).toString("hex");
    user.resetToken = token;
    user.resetTokenExpiry = new Date(Date.now() + 1000 * 60 * 60); // 1 hour
    await user.save();
    const resetUrl = `${process.env.FRONTEND_URL || "http://localhost:5173"}/reset-password?token=${token}`;
    await sendMail({
      to: email,
      subject: "Password Reset",
      html: `<p>Click the link below to reset your password. It expires in 1 hour.</p><a href="${resetUrl}">${resetUrl}</a>`
    });
    res.json({ message: "If that email exists, a reset link was sent." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/reset-password", async (req, res) => {
  const { token, password } = req.body;
  try {
    const user = await User.findOne({ resetToken: token, resetTokenExpiry: { $gt: new Date() } });
    if (!user) return res.status(400).json({ error: "Invalid or expired reset token." });
    user.password = password;
    user.resetToken = undefined;
    user.resetTokenExpiry = undefined;
    await user.save();
    res.json({ message: "Password reset successful. You can now log in." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
