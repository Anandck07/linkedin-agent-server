import { PLANS, resetUsageIfNeeded } from "../routes/billing.js";
import User from "../models/User.js";

export const checkPostLimit = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    await resetUsageIfNeeded(user);

    const limit = PLANS[user.plan]?.postsPerMonth ?? 5;
    if (user.postsThisMonth >= limit) {
      return res.status(403).json({
        error: `You've reached your ${limit} posts/month limit on the ${user.plan} plan. Upgrade to Pro for unlimited posts.`,
        limitReached: true,
        plan: user.plan,
      });
    }

    user.postsThisMonth += 1;
    await user.save();
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export const checkScheduleLimit = async (req, res, next) => {
  try {
    const user = await User.findById(req.user._id);
    const limit = PLANS[user.plan]?.scheduledPosts ?? 2;
    if (limit === Infinity) return next();

    const scheduledCount = user.posts.filter(p =>
      ["scheduled", "retrying"].includes(p.scheduleStatus)
    ).length;

    if (scheduledCount >= limit) {
      return res.status(403).json({
        error: `You've reached your ${limit} scheduled posts limit on the ${user.plan} plan. Upgrade to Pro for unlimited scheduling.`,
        limitReached: true,
        plan: user.plan,
      });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
