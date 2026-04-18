import express from "express";
import Stripe from "stripe";
import { protect } from "../middleware/auth.js";
import User from "../models/User.js";

const router = express.Router();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export const PLANS = {
  free:     { postsPerMonth: 5,  scheduledPosts: 2  },
  pro:      { postsPerMonth: Infinity, scheduledPosts: Infinity },
  business: { postsPerMonth: Infinity, scheduledPosts: Infinity },
};

// Reset monthly usage if billing cycle has passed
export const resetUsageIfNeeded = async (user) => {
  const now = new Date();
  const cycleStart = new Date(user.billingCycleStart);
  const diffDays = (now - cycleStart) / (1000 * 60 * 60 * 24);
  if (diffDays >= 30) {
    user.postsThisMonth = 0;
    user.billingCycleStart = now;
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
        features: ["5 posts/month", "2 scheduled posts", "All 5 AI agents", "Post history"],
      },
      {
        id: "pro",
        name: "Pro",
        price: 9,
        priceId: process.env.STRIPE_PRO_PRICE_ID,
        features: ["Unlimited posts", "Unlimited scheduling", "All 5 AI agents", "Priority support", "Analytics"],
      },
      {
        id: "business",
        name: "Business",
        price: 29,
        priceId: process.env.STRIPE_BUSINESS_PRICE_ID,
        features: ["Everything in Pro", "Team collaboration", "Custom branding", "Dedicated support", "API access"],
      },
    ],
  });
});

// POST /api/billing/checkout  — create Stripe checkout session
router.post("/checkout", protect, async (req, res) => {
  const { priceId } = req.body;
  if (!priceId) return res.status(400).json({ error: "priceId is required" });

  try {
    const user = await User.findById(req.user._id);
    let customerId = user.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.name });
      customerId = customer.id;
      user.stripeCustomerId = customerId;
      await user.save();
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/dashboard?upgrade=success`,
      cancel_url:  `${process.env.FRONTEND_URL}/dashboard?upgrade=cancelled`,
      metadata: { userId: user._id.toString() },
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/portal — customer billing portal (manage/cancel)
router.post("/portal", protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user.stripeCustomerId)
      return res.status(400).json({ error: "No billing account found." });

    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${process.env.FRONTEND_URL}/dashboard`,
    });
    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/billing/webhook — Stripe webhook
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  const session = event.data.object;

  if (event.type === "checkout.session.completed") {
    const userId = session.metadata?.userId;
    const subscriptionId = session.subscription;
    if (userId && subscriptionId) {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId);
      const priceId = subscription.items.data[0]?.price?.id;
      const plan = priceId === process.env.STRIPE_BUSINESS_PRICE_ID ? "business" : "pro";
      await User.findByIdAndUpdate(userId, { plan, stripeSubscriptionId: subscriptionId });
    }
  }

  if (event.type === "customer.subscription.deleted") {
    await User.findOneAndUpdate(
      { stripeSubscriptionId: session.id },
      { plan: "free", stripeSubscriptionId: null }
    );
  }

  if (event.type === "customer.subscription.updated") {
    const priceId = session.items?.data[0]?.price?.id;
    const plan = priceId === process.env.STRIPE_BUSINESS_PRICE_ID ? "business"
               : priceId === process.env.STRIPE_PRO_PRICE_ID      ? "pro" : "free";
    await User.findOneAndUpdate({ stripeSubscriptionId: session.id }, { plan });
  }

  res.json({ received: true });
});

export default router;
