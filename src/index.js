import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import path from "path";
import cron from "node-cron";
import { fileURLToPath } from "url";
import authRoutes from "./routes/auth.js";
import dashboardRoutes from "./routes/dashboard.js";
import subscriptionRoutes from "./routes/subscription.js";
import adminRoutes from "./routes/admin.js";
import { getAccessToken, getProfile } from "./linkedin.js";
import User from "./models/User.js";
import Subscription from "./models/Subscription.js";
import { startScheduledPostWorker } from "./scheduler.js";

const app = express();
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.resolve(__dirname, "../uploads");

app.use(cors({ origin: true, credentials: true, methods: ["GET","POST","PUT","DELETE","OPTIONS"], allowedHeaders: ["Content-Type","Authorization","Accept"] }));
app.options("*", cors({ origin: true, credentials: true }));
app.use(express.json());
app.use("/uploads", express.static(uploadsDir));
app.get("/ping", (_req, res) => res.send("ok"));

app.get("/test-email", async (_req, res) => {
  try {
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({
      from: "LinkedIn AI Agent <onboarding@resend.dev>",
      to: process.env.SMTP_USER,
      subject: "Test OTP Email",
      html: "<p>Test email works! OTP: 123456</p>"
    });
    res.json({ success: true, result, key_prefix: process.env.RESEND_API_KEY?.slice(0, 8) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug endpoint
app.get("/debug-time", async (_req, res) => {
  const now = new Date();
  const users = await User.find({}).select("email posts").catch(() => []);
  const allPosts = users.flatMap(u => u.posts.slice(0, 5).map(p => ({
    email: u.email,
    content: p.content?.slice(0, 40),
    scheduleStatus: p.scheduleStatus,
    scheduledFor_UTC: p.scheduledFor || null,
    scheduledFor_IST: p.scheduledFor ? new Date(p.scheduledFor).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : null,
    postedToLinkedIn: p.postedToLinkedIn,
    isDue: p.scheduledFor ? new Date(p.scheduledFor) <= now : null
  })));
  res.json({ serverNow_UTC: now.toISOString(), serverNow_IST: now.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }), totalPosts: allPosts.length, posts: allPosts });
});

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB error:", err));

app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/subscription", subscriptionRoutes);
app.use("/api/admin", adminRoutes);

// LinkedIn OAuth callback
app.get("/auth/linkedin/callback", async (req, res) => {
  const { code, state } = req.query;
  try {
    const user = await User.findById(state);
    if (!user) return res.status(404).send("User not found");
    const tokenData = await getAccessToken(code, user.credentials);
    const profile = await getProfile(tokenData.access_token);
    user.linkedinAccessToken = tokenData.access_token;
    user.linkedinRefreshToken = tokenData.refresh_token || user.linkedinRefreshToken;
    if (tokenData.expires_in)
      user.linkedinTokenExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
    user.linkedinPersonId = profile.sub;
    await user.save();
    res.redirect(`${FRONTEND_URL}/dashboard?linkedin=connected`);
  } catch (err) {
    res.redirect(`${FRONTEND_URL}/dashboard?linkedin=error`);
  }
});

app.post("/auth/linkedin/exchange", async (req, res) => {
  const { code, state } = req.body;
  try {
    const user = await User.findById(state);
    if (!user) return res.status(404).json({ error: "User not found" });
    if (!user.credentials?.linkedinClientId || !user.credentials?.linkedinClientSecret)
      return res.status(400).json({ error: "LinkedIn credentials not saved." });
    const tokenData = await getAccessToken(code, user.credentials);
    const profile = await getProfile(tokenData.access_token);
    user.linkedinAccessToken = tokenData.access_token;
    user.linkedinRefreshToken = tokenData.refresh_token || user.linkedinRefreshToken;
    if (tokenData.expires_in)
      user.linkedinTokenExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);
    user.linkedinPersonId = profile.sub;
    await user.save();
    res.json({ success: true });
  } catch (err) {
    const msg = err.response?.data?.error_description || err.message;
    res.status(500).json({ error: msg });
  }
});

// Cron: expire plans daily at midnight
cron.schedule("0 0 * * *", async () => {
  try {
    const expired = await User.find({ plan: { $ne: "free" }, planExpiry: { $lt: new Date() } });
    for (const user of expired) {
      user.plan = "free";
      user.planExpiry = undefined;
      await user.save();
      await Subscription.findOneAndUpdate({ userId: user._id, status: "active" }, { status: "expired" });
      console.log(`[Cron] Plan expired for ${user.email}`);
    }
  } catch (err) {
    console.error("[Cron] Expiry check error:", err.message);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
startScheduledPostWorker();
