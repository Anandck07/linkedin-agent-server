import "dotenv/config";
import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import authRoutes from "./routes/auth.js";
import dashboardRoutes from "./routes/dashboard.js";
import { getAccessToken, getProfile } from "./linkedin.js";
import User from "./models/User.js";
import { startScheduledPostWorker } from "./scheduler.js";

const app = express();
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const BACKEND_URL  = process.env.BACKEND_URL  || "http://localhost:5000";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.resolve(__dirname, "../uploads");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use("/uploads", express.static(uploadsDir));

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB error:", err));

app.use("/api/auth", authRoutes);
app.use("/api/dashboard", dashboardRoutes);

// LinkedIn OAuth callback — looks up user by state (userId)
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

// Frontend-initiated LinkedIn code exchange
app.post("/auth/linkedin/exchange", async (req, res) => {
  const { code, state } = req.body;
  try {
    const user = await User.findById(state);
    if (!user) return res.status(404).json({ error: "User not found" });
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
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));
startScheduledPostWorker();
