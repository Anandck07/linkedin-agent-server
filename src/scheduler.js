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

const getRetryDelayMs = (attempts) => {
  const base = 60 * 1000;
  const delay = Math.min(base * (2 ** Math.max(0, attempts - 1)), 60 * 60 * 1000);
  return delay;
};

const duePostFilter = (post) => {
  if (!post.scheduledFor) return false;
  if (post.postedToLinkedIn) return false;
  if (!["scheduled", "retrying"].includes(post.scheduleStatus)) return false;
  return new Date(post.scheduledFor).getTime() <= Date.now();
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
    const users = await User.find({
      linkedinAccessToken: { $exists: true, $ne: null },
      linkedinPersonId: { $exists: true, $ne: null },
      posts: {
        $elemMatch: {
          scheduleStatus: { $in: ["scheduled", "retrying"] },
          scheduledFor: { $lte: new Date() },
          postedToLinkedIn: false
        }
      }
    });

    for (const user of users) {
      const duePosts = user.posts.filter(duePostFilter);
      if (!duePosts.length) continue;

      for (const post of duePosts) {
        if (post.scheduleAttempts >= MAX_RETRIES) {
          post.scheduleStatus = "failed";
          post.lastScheduleError = `Reached max retries (${MAX_RETRIES})`;
          continue;
        }

        try {
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
          post.scheduledFor = undefined;
        } catch (err) {
          post.scheduleAttempts += 1;
          post.lastScheduleError = normalizeError(err);

          if (isRetryableError(err) && post.scheduleAttempts < MAX_RETRIES) {
            post.scheduleStatus = "retrying";
            post.scheduledFor = new Date(Date.now() + getRetryDelayMs(post.scheduleAttempts));
          } else {
            post.scheduleStatus = "failed";
          }
        }
      }

      await user.save();
    }
  } catch (err) {
    console.error("Scheduled post worker error:", normalizeError(err));
  } finally {
    isRunning = false;
  }
};

export const startScheduledPostWorker = () => {
  // Runs at every minute exactly (e.g. 3:00:00, 3:01:00)
  cron.schedule("* * * * *", () => {
    processDueScheduledPosts();
  });
  console.log("Scheduled post worker started (node-cron, every minute)");
};
