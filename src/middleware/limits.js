import UsageTracking from "../models/UsageTracking.js";
import { getPlanLimits } from "../config/plans.js";

// Reset usage if monthly cycle passed
const resetIfNeeded = async (usage) => {
  if (new Date() >= new Date(usage.resetDate)) {
    usage.postsUsed = 0;
    usage.schedulesUsed = 0;
    usage.peakTimingUsed = 0;
    usage.resetDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await usage.save();
  }
};

const getUsage = async (userId) => {
  let usage = await UsageTracking.findOne({ userId });
  if (!usage) usage = await UsageTracking.create({ userId });
  await resetIfNeeded(usage);
  return usage;
};

// Check plan expiry
const isPlanActive = (user) => {
  if (user.plan === "free") return true;
  if (!user.planExpiry) return false;
  return new Date() < new Date(user.planExpiry);
};

export const checkPostLimit = async (req, res, next) => {
  try {
    const user = req.user;
    const plan = isPlanActive(user) ? user.plan : "free";
    const limits = getPlanLimits(plan);
    const usage = await getUsage(user._id);

    if (limits.postsPerMonth !== Infinity && usage.postsUsed >= limits.postsPerMonth) {
      return res.status(403).json({
        error: `You've used all ${limits.postsPerMonth} posts for this month on the ${plan} plan.`,
        limitReached: true, plan, upgrade: plan === "free" ? "pro" : "premium"
      });
    }

    usage.postsUsed += 1;
    await usage.save();
    req.usage = usage;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const checkScheduleLimit = async (req, res, next) => {
  try {
    const user = req.user;
    const plan = isPlanActive(user) ? user.plan : "free";
    const limits = getPlanLimits(plan);

    if (!limits.features.scheduling) {
      return res.status(403).json({
        error: "Scheduling is not available on the Free plan. Upgrade to Pro or Premium.",
        limitReached: true, plan, upgrade: "pro"
      });
    }

    const usage = await getUsage(user._id);
    if (limits.schedulesPerMonth !== Infinity && usage.schedulesUsed >= limits.schedulesPerMonth) {
      return res.status(403).json({
        error: `You've used all ${limits.schedulesPerMonth} scheduled posts for this month.`,
        limitReached: true, plan, upgrade: "premium"
      });
    }

    usage.schedulesUsed += 1;
    await usage.save();
    req.usage = usage;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const checkPeakTiming = async (req, res, next) => {
  try {
    const user = req.user;
    const plan = isPlanActive(user) ? user.plan : "free";
    const limits = getPlanLimits(plan);

    if (!limits.features.peakTiming) {
      return res.status(403).json({
        error: "Real-Time Peak Timing is not available on the Free plan. Upgrade to Pro.",
        limitReached: true, plan, upgrade: "pro"
      });
    }

    const usage = await getUsage(user._id);
    if (limits.peakTimingPerMonth !== Infinity && usage.peakTimingUsed >= limits.peakTimingPerMonth) {
      return res.status(403).json({
        error: `You've used all ${limits.peakTimingPerMonth} Peak Timing requests this month.`,
        limitReached: true, plan, upgrade: "premium"
      });
    }

    usage.peakTimingUsed += 1;
    await usage.save();
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const checkAIAccess = (req, res, next) => {
  const user = req.user;
  const plan = isPlanActive(user) ? user.plan : "free";
  const limits = getPlanLimits(plan);
  if (!limits.features.aiGeneration) {
    return res.status(403).json({
      error: "AI generation is not available on the Free plan. Upgrade to Pro.",
      limitReached: true, plan, upgrade: "pro"
    });
  }
  next();
};

export const requireAdmin = (req, res, next) => {
  if (!req.user?.isAdmin) return res.status(403).json({ error: "Admin access required" });
  next();
};
