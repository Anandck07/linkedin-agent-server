import express from "express";
import Razorpay from "razorpay";
import crypto from "crypto";
import { protect } from "../middleware/auth.js";
import User from "../models/User.js";

const router = express.Router();

const getRazorpay = () => {
  if (!process.env.RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID.startsWith("rzp_test_..."))
    throw new Error("Razorpay is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to your .env");
  return new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
};

export const PLANS = {
  free:     { postsPerMonth: 5,        scheduledPosts: 2        },
  pro:      { postsPerMonth: Infinity, scheduledPosts: Infinity },
  business: { postsPerMonth: Infinity, scheduledPosts: Infinity },
};

export const resetUsageIfNeeded = async (user) => {
  const diffDays = (new Date() - new Date(user.billingCycleStart)) / (1000 * 60 * 60 * 24);
  if (diffDays >= 30) {
    user.postsThisMonth = 0;
    user.billingCycleStart = new Date();
    await user.save();
  }
};

// GET /api/billing/plans
router.get("/plans", (_req, res) => {
  res.json({
    plans: [
      {
        id: "free",
        name: "Free",
        price: 0,
        currency: "INR",
        features: ["5 posts/month", "2 scheduled posts", "All 5 AI agents", "Post history"],
      },
      {
        id: "pro",
        name: "Pro",
        price: 749,
        currency: "INR",
        planId: process.env.RAZORPAY_PRO_PLAN_ID,
        features: ["Unlimited posts", "Unlimited scheduling", "All 5 AI agents", "Priority support", "Analytics"],
      },
      {
        id: "business",
        name: "Business",
        price: 2399,
        currency: "INR",
        planId: process.env.RAZORPAY_BUSINESS_PLAN_ID,
        features: ["Everything in Pro", "Team collaboration", "Custom branding", "Dedicated support", "API access"],
      },
    ],
  });
});

// POST /api/billing/checkout — create Razorpay subscription
router.post("/checkout", protect, async (req, res) => {
  const { planId } = req.body;
  if (!planId) return res.status(400).json({ error: "planId is required" });
  try {
    const razorpay = getRazorpay();
    const user = await User.findById(req.user._id);
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      total_count: 12,
      notes: { userId: user._id.toString(), email: user.email },
    });
    user.razorpaySubscriptionId = subscription.id;
    await user.save();
    res.json({
      subscriptionId: subscription.id,
      keyId: process.env.RAZORPAY_KEY_ID,
      name: user.name,
      email: user.email,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/verify — verify payment signature after checkout
router.post("/verify", protect, async (req, res) => {
  const { razorpay_payment_id, razorpay_subscription_id, razorpay_signature, planType } = req.body;
  try {
    const body = razorpay_payment_id + "|" + razorpay_subscription_id;
    const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(body).digest("hex");
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: "Payment verification failed." });

    const plan = planType === "business" ? "business" : "pro";
    await User.findByIdAndUpdate(req.user._id, { plan, razorpaySubscriptionId: razorpay_subscription_id });
    res.json({ success: true, plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/cancel — cancel subscription
router.post("/cancel", protect, async (req, res) => {
  try {
    const razorpay = getRazorpay();
    const user = await User.findById(req.user._id);
    if (!user.razorpaySubscriptionId)
      return res.status(400).json({ error: "No active subscription found." });
    await razorpay.subscriptions.cancel(user.razorpaySubscriptionId);
    user.plan = "free";
    user.razorpaySubscriptionId = null;
    await user.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/webhook — Razorpay webhook
router.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["x-razorpay-signature"];
  const body = req.body;
  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest("hex");
  if (expected !== sig) return res.status(400).json({ error: "Invalid signature" });

  const event = JSON.parse(body);
  if (event.event === "subscription.cancelled" || event.event === "subscription.completed") {
    const subId = event.payload?.subscription?.entity?.id;
    if (subId) User.findOneAndUpdate({ razorpaySubscriptionId: subId }, { plan: "free", razorpaySubscriptionId: null }).catch(() => {});
  }
  res.json({ received: true });
});

export default router;
