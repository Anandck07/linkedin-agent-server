import User from "./models/User.js";
import { ensureFreshLinkedInToken, postToLinkedIn } from "./linkedin.js";
import { promises as fsp } from "fs";
import path from "path";
import cron from "node-cron";
import { fileURLToPath } from "url";

const MAX_RETRIES = 5;
let isRunning = false;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadsDir = path.resolve(__dirname, "../uploads");

const normalizeError = (err) => {
  if (!err) return "Unknown error";
  return err.response?.data?.message || err.response?.data?.error || err.message || "Unknown error";
};

const isRetryableError = (err) => {
  const status = err?.response?.status;
  const code = err?.code;
  if ([429, 500, 502, 503, 504].includes(status)) return true;
  if (["ECONNABORTED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EAI_AGAIN"].includes(code)) return true;
  return false;
};

const getImageBuffer = async (imagePath) => {
  if (!imagePath || !imagePath.startsWith("/uploads/")) return null;
  const fullPath = path.join(uploadsDir, path.basename(imagePath));
  return fsp.readFile(fullPath);
};

const processDueScheduledPosts = async () => {
  if (isRunning) return;
  isRunning = true;

  try {
    const nowUTC = new Date();

    // Find users with posts due NOW
    const users = await User.find({
      linkedinAccessToken: { $exists: true, $ne: null },
      linkedinPersonId: { $exists: true, $ne: null },
      posts: {
        $elemMatch: {
          scheduleStatus: { $in: ["scheduled", "retrying"] },
          scheduledFor: { $lte: nowUTC },
          postedToLinkedIn: false
        }
      }
    });

    if (users.length > 0) {
      console.log(`[Scheduler] ${nowUTC.toISOString()} — found ${users.length} user(s) with due posts`);
    }

    for (const user of users) {
      const duePosts = user.posts.filter(p => {
        if (!p.scheduledFor || p.postedToLinkedIn) return false;
        if (!["scheduled", "retrying"].includes(p.scheduleStatus)) return false;
        const due = new Date(p.scheduledFor).getTime() <= nowUTC.getTime();
        console.log(`[Scheduler] Post ${p._id}: scheduledFor=${new Date(p.scheduledFor).toISOString()} now=${nowUTC.toISOString()} due=${due}`);
        return due;
      });

      if (!duePosts.length) continue;

      for (const post of duePosts) {
        if (post.scheduleAttempts >= MAX_RETRIES) {
          post.scheduleStatus = "failed";
          post.lastScheduleError = `Reached max retries (${MAX_RETRIES})`;
          continue;
        }

        try {
          console.log(`[Scheduler] Posting now: "${post.content?.slice(0, 40)}..."`);
          post.scheduleStatus = "posting";
          await user.save();

          const accessToken = await ensureFreshLinkedInToken(user);
          const linkedinPostUrn = await postToLinkedIn(
            accessToken,
            user.linkedinPersonId,
            post.content,
            await getImageBuffer(post.image).catch(() => null)
          );

          post.postedToLinkedIn = true;
          post.scheduleStatus = "posted";
          post.publishedAt = new Date();
          if (linkedinPostUrn) post.linkedinPostUrn = linkedinPostUrn;
          post.metricsUpdatedAt = new Date();
          post.lastScheduleError = undefined;
          console.log(`[Scheduler] ✅ Posted successfully at ${new Date().toISOString()}`);
        } catch (err) {
          post.scheduleAttempts += 1;
          post.lastScheduleError = normalizeError(err);
          console.error(`[Scheduler] ❌ Failed: ${post.lastScheduleError}`);

          if (isRetryableError(err) && post.scheduleAttempts < MAX_RETRIES) {
            post.scheduleStatus = "retrying";
            const delay = Math.min(60000 * (2 ** (post.scheduleAttempts - 1)), 3600000);
            post.scheduledFor = new Date(Date.now() + delay);
          } else {
            post.scheduleStatus = "failed";
          }
        }
      }

      await user.save();
    }
  } catch (err) {
    console.error("[Scheduler] Worker error:", normalizeError(err));
  } finally {
    isRunning = false;
  }
};

export const startScheduledPostWorker = () => {
  cron.schedule("* * * * *", () => {
    processDueScheduledPosts();
  });

  const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:10000";
  cron.schedule("*/10 * * * *", async () => {
    try { await fetch(`${BACKEND_URL}/ping`); } catch {}
  });

  console.log("[Scheduler] Started — runs every minute");
};
