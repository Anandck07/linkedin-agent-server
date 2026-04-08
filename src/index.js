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

const allowedOrigins = [
  ...FRONTEND_URL.split(",").map((url) => url.trim()).filter(Boolean),
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];

app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin) return callback(null, true);

    const isLocalhostPort = /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(origin);
    if (isLocalhostPort || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked for origin: ${origin}`));
  }
}));
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
startScheduledPostWorker();
