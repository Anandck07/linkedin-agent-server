import express from "express";
import multer from "multer";
import fs from "fs";
import { promises as fsp } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Groq from "groq-sdk";
import { protect } from "../middleware/auth.js";
import { checkPostLimit, checkScheduleLimit, checkPeakTiming } from "../middleware/limits.js";
import User from "../models/User.js";
import { linkedinAgent, linkedinImagePromptAgent, bestTimeAgent } from "../agents.js";
import { ensureFreshLinkedInToken, getAuthUrl, getLinkedInPostMetrics, postToLinkedIn } from "../linkedin.js";

const router = express.Router();
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.resolve(__dirname, "../../uploads");
fs.mkdirSync(uploadsDir, { recursive: true });

const resolveUploadPath = (imagePath) => {
  if (!imagePath || !imagePath.startsWith("/uploads/")) return null;
  return path.join(uploadsDir, path.basename(imagePath));
};

const memoryUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_SIZE } });
const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeExt = ext && ext.length <= 10 ? ext : ".jpg";
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
  }
});
const diskUpload = multer({ storage: diskStorage, limits: { fileSize: MAX_FILE_SIZE } });

const readStoredImage = async (imagePath) => {
  const fullPath = resolveUploadPath(imagePath);
  if (!fullPath) return null;
  return fsp.readFile(fullPath);
};

const persistMemoryUpload = async (file) => {
  if (!file?.buffer) return null;
  const ext = path.extname(file.originalname || "").toLowerCase();
  const safeExt = ext && ext.length <= 10 ? ext : ".jpg";
  const filePath = path.join(uploadsDir, `${Date.now()}-${Math.round(Math.random() * 1e9)}${safeExt}`);
  await fsp.writeFile(filePath, file.buffer);
  return `/uploads/${path.basename(filePath)}`;
};

// Parse scheduled time — accepts ISO string with offset (e.g. 2025-01-15T00:00:00+05:30)
const parseScheduleTime = (str) => {
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  return d;
};

const getFriendlyErrorMessage = (err) => {
  const apiError = err?.response?.data?.error;
  const message = apiError?.message || err?.message || "Something went wrong";
  const code = apiError?.code || err?.code;
  if (code === "expired_api_key" || /expired api key|invalid api key/i.test(message))
    return "Your Groq API key is invalid or expired. Please update it in Settings.";
  return message;
};

const validateGroqApiKey = async (apiKey) => {
  const groq = new Groq({ apiKey });
  await groq.models.list();
};

// Save user API credentials — only overwrite fields that are non-empty
router.post("/credentials", protect, async (req, res) => {
  const { groqApiKey, linkedinClientId, linkedinClientSecret, linkedinRedirectUri } = req.body;
  const user = await User.findById(req.user._id);
  const existing = user.credentials || {};

  const incomingGroqKey = groqApiKey?.trim();
  if (incomingGroqKey) {
    try {
      await validateGroqApiKey(incomingGroqKey);
    } catch {
      return res.status(400).json({ error: "Invalid or expired Groq API key. Please enter a valid key." });
    }
  }

  const updated = {
    groqApiKey:           incomingGroqKey              || existing.groqApiKey,
    linkedinClientId:     linkedinClientId?.trim()     || existing.linkedinClientId,
    linkedinClientSecret: linkedinClientSecret?.trim() || existing.linkedinClientSecret,
    linkedinRedirectUri:  linkedinRedirectUri?.trim()  || existing.linkedinRedirectUri,
  };
  await User.findByIdAndUpdate(req.user._id, { credentials: updated });
  res.json({ success: true });
});

// Get user profile + credentials status
router.get("/me", protect, async (req, res) => {
  const user = await User.findById(req.user._id).select("-password");

  if (user.linkedinPersonId && user.posts?.length) {
    try {
      const refreshWindowMs = 15 * 60 * 1000;
      const now = Date.now();
      const postsNeedingRefresh = user.posts
        .filter((p) => p.postedToLinkedIn && p.linkedinPostUrn)
        .filter((p) => !p.metricsUpdatedAt || now - new Date(p.metricsUpdatedAt).getTime() > refreshWindowMs)
        .slice(0, 5);

      if (postsNeedingRefresh.length) {
        const accessToken = await ensureFreshLinkedInToken(user);

        for (const post of postsNeedingRefresh) {
          try {
            const metrics = await getLinkedInPostMetrics(accessToken, post.linkedinPostUrn);
            post.likesCount = metrics.likes;
            post.commentsCount = metrics.comments;
            post.metricsUpdatedAt = new Date();
          } catch {
            // Ignore per-post metrics errors so profile still loads.
          }
        }

        await user.save();
      }
    } catch {
      // Ignore metrics refresh errors in /me API.
    }
  }

  const c = user.credentials || {};
  res.json({
    name: user.name,
    email: user.email,
    hasCredentials: !!(c.groqApiKey && c.linkedinClientId),
    linkedinConnected: !!user.linkedinPersonId,
    plan: user.plan || "free",
    planExpiry: user.planExpiry || null,
    planActive: user.plan === "free" || (user.planExpiry && new Date() < new Date(user.planExpiry)),
    savedFields: {
      groqApiKey:           !!c.groqApiKey,
      linkedinClientId:     !!c.linkedinClientId,
      linkedinClientSecret: !!c.linkedinClientSecret,
      linkedinRedirectUri:  !!c.linkedinRedirectUri,
    },
    isAdmin: user.isAdmin,
    posts: user.posts
  });
  console.log(`[/me] User: ${user.email} | isAdmin: ${user.isAdmin} (${typeof user.isAdmin})`);
});

// Temporary route to fix admin status
router.get("/make-me-admin", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    user.isAdmin = true;
    await user.save();
    res.json({ success: true, message: "You are now an admin! Please refresh the dashboard." });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Real-time Standalone Best Time to Post API
router.get("/best-time", protect, checkPeakTiming, async (req, res) => {
  const { industry } = req.query;
  const user = await User.findById(req.user._id);

  if (!user.credentials?.groqApiKey) {
    return res.status(400).json({ error: "Please add your Groq API key in settings" });
  }

  try {
    const bestTime = await bestTimeAgent(user.credentials.groqApiKey, industry || "General");
    res.json({ bestTime });
  } catch (err) {
    res.status(500).json({ error: getFriendlyErrorMessage(err) });
  }
});

// Generate post using user's own Groq key
router.post("/generate", protect, checkPostLimit, async (req, res) => {
  const { topic } = req.body;
  const user = await User.findById(req.user._id);
  if (!user.credentials?.groqApiKey)
    return res.status(400).json({ error: "Please add your Groq API key in settings" });
  try {
    const { post, bestTime } = await linkedinAgent(topic, user.credentials.groqApiKey);
    // Save to history
    user.posts.unshift({ topic, content: post });
    await user.save();
    res.json({ post, bestTime, postId: user.posts[0]._id });
  } catch (err) {
    res.status(500).json({ error: getFriendlyErrorMessage(err) });
  }
});

// Generate schedule text from entered prompt (no DB save)
router.post("/schedule/generate-from-prompt", protect, async (req, res) => {
  const { prompt } = req.body;
  const user = await User.findById(req.user._id);

  if (!prompt?.trim())
    return res.status(400).json({ error: "Please enter prompt text" });
  if (!user.credentials?.groqApiKey)
    return res.status(400).json({ error: "Please add your Groq API key in settings" });

  try {
    const { post, bestTime } = await linkedinAgent(prompt.trim(), user.credentials.groqApiKey);
    res.json({ post, bestTime });
  } catch (err) {
    res.status(500).json({ error: getFriendlyErrorMessage(err) });
  }
});

// Generate schedule text from prompt + image
router.post("/schedule/generate-from-image", protect, memoryUpload.single("image"), async (req, res) => {
  const { prompt } = req.body;
  const user = await User.findById(req.user._id);

  if (!user.credentials?.groqApiKey)
    return res.status(400).json({ error: "Please add your Groq API key in settings" });
  if (!req.file?.buffer)
    return res.status(400).json({ error: "Please upload an image to generate text" });

  try {
    const generatedText = await linkedinImagePromptAgent({
      prompt,
      imageBuffer: req.file.buffer,
      imageMimeType: req.file.mimetype || "image/jpeg",
      groqApiKey: user.credentials.groqApiKey
    });

    if (!generatedText) return res.status(500).json({ error: "Could not generate post text from image" });
    res.json({ post: generatedText });
  } catch (err) {
    res.status(500).json({ error: getFriendlyErrorMessage(err) });
  }
});

// LinkedIn OAuth URL (per user credentials)
router.get("/linkedin/auth", protect, async (req, res) => {
  const user = await User.findById(req.user._id);
  if (!user.credentials?.linkedinClientId)
    return res.status(400).json({ error: "Please add LinkedIn credentials first" });
  const url = getAuthUrl(user.credentials) + `&state=${user._id}`;
  res.json({ url });
});

// Publish post to LinkedIn
router.post("/publish", protect, memoryUpload.single("image"), async (req, res) => {
  const { postId, content } = req.body;
  const user = await User.findById(req.user._id);
  if (!user.linkedinAccessToken)
    return res.status(401).json({ error: "LinkedIn not connected" });

  const postDoc = user.posts.id(postId);
  if (!postDoc) return res.status(404).json({ error: "Post not found" });
  if (typeof content === "string" && content.trim()) postDoc.content = content.trim();

  try {
    const accessToken = await ensureFreshLinkedInToken(user);
    const imageBuffer = req.file?.buffer ?? await readStoredImage(postDoc.image).catch(() => null);

    const linkedinPostUrn = await postToLinkedIn(
      accessToken,
      user.linkedinPersonId,
      postDoc.content,
      imageBuffer,
      user.credentials
    );
    postDoc.postedToLinkedIn = true;
    postDoc.scheduleStatus = "posted";
    postDoc.publishedAt = new Date();
    if (linkedinPostUrn) postDoc.linkedinPostUrn = linkedinPostUrn;
    postDoc.metricsUpdatedAt = new Date();
    postDoc.scheduledFor = undefined;
    postDoc.lastScheduleError = undefined;
    if (req.file) postDoc.image = await persistMemoryUpload(req.file);
    await user.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Schedule a post to publish later
router.post("/schedule", protect, checkScheduleLimit, (req, res, next) => {
  const ct = req.headers["content-type"] || "";
  if (ct.includes("multipart/form-data")) return diskUpload.single("image")(req, res, next);
  next();
}, async (req, res) => {
  const { postId, scheduledFor, content } = req.body;
  if (!postId || !scheduledFor)
    return res.status(400).json({ error: "postId and scheduledFor are required" });

  const scheduledAt = parseScheduleTime(scheduledFor);
  if (!scheduledAt)
    return res.status(400).json({ error: "Invalid date/time format" });

  const user = await User.findById(req.user._id);
  if (!user.linkedinAccessToken || !user.linkedinPersonId)
    return res.status(401).json({ error: "Connect LinkedIn before scheduling" });

  const postDoc = user.posts.id(postId);
  if (!postDoc) return res.status(404).json({ error: "Post not found" });
  if (postDoc.postedToLinkedIn)
    return res.status(400).json({ error: "Post is already published" });
  if (typeof content === "string" && content.trim()) postDoc.content = content.trim();

  postDoc.scheduleStatus = "scheduled";
  postDoc.scheduledFor = scheduledAt;
  postDoc.scheduleAttempts = 0;
  postDoc.lastScheduleError = undefined;
  if (req.file?.filename) postDoc.image = `/uploads/${req.file.filename}`;

  await user.save();
  console.log(`[Schedule] Saved: ${scheduledAt.toISOString()} | Now: ${new Date().toISOString()}`);
  res.json({ success: true, scheduledFor: scheduledAt.toISOString() });
});

// Create a brand-new scheduled post from scratch (text + optional image + datetime)
router.post("/schedule/new", protect, checkScheduleLimit, (req, res, next) => {
  const ct = req.headers["content-type"] || "";
  if (ct.includes("multipart/form-data")) return diskUpload.single("image")(req, res, next);
  next();
}, async (req, res) => {
  const { content, scheduledFor } = req.body;
  if (!content?.trim() || !scheduledFor)
    return res.status(400).json({ error: "content and scheduledFor are required" });

  const scheduledAt = parseScheduleTime(scheduledFor);
  if (!scheduledAt)
    return res.status(400).json({ error: "Invalid date/time format" });

  const user = await User.findById(req.user._id);
  const newPost = {
    topic: "Manual Schedule",
    content: content.trim(),
    scheduleStatus: "scheduled",
    scheduledFor: scheduledAt,
    scheduleAttempts: 0,
    ...(req.file?.filename && { image: `/uploads/${req.file.filename}` })
  };

  user.posts.unshift(newPost);
  await user.save();
  console.log(`[Schedule/New] Saved: ${scheduledAt.toISOString()} | Now: ${new Date().toISOString()}`);
  res.json({ success: true, postId: user.posts[0]._id, scheduledFor: scheduledAt.toISOString() });
});

// Cancel a scheduled/retrying post
router.post("/schedule/:postId/cancel", protect, async (req, res) => {
  const user = await User.findById(req.user._id);
  const postDoc = user.posts.id(req.params.postId);

  if (!postDoc) return res.status(404).json({ error: "Post not found" });
  if (!["scheduled", "retrying"].includes(postDoc.scheduleStatus))
    return res.status(400).json({ error: "Only scheduled/retrying posts can be cancelled" });

  postDoc.scheduleStatus = "draft";
  postDoc.scheduledFor = undefined;
  postDoc.lastScheduleError = undefined;

  await user.save();
  res.json({ success: true });
});

// Add or replace image on an existing post
router.post("/posts/:postId/image", protect, diskUpload.single("image"), async (req, res) => {
  if (!req.file?.filename)
    return res.status(400).json({ error: "Please upload an image" });

  const user = await User.findById(req.user._id);
  const postDoc = user.posts.id(req.params.postId);
  if (!postDoc) return res.status(404).json({ error: "Post not found" });

  if (postDoc.image?.startsWith("/uploads/")) {
    const oldPath = resolveUploadPath(postDoc.image);
    if (oldPath) await fsp.unlink(oldPath).catch(() => {});
  }

  postDoc.image = `/uploads/${req.file.filename}`;
  await user.save();
  res.json({ success: true, image: postDoc.image });
});

// Delete post from history
router.delete("/posts/:postId", protect, async (req, res) => {
  const user = await User.findById(req.user._id);
  const postDoc = user.posts.id(req.params.postId);
  if (postDoc?.image?.startsWith("/uploads/")) {
    const fullPath = resolveUploadPath(postDoc.image);
    if (fullPath) await fsp.unlink(fullPath).catch(() => {});
  }
  user.posts.pull(req.params.postId);
  await user.save();
  res.json({ success: true });
});

export default router;
