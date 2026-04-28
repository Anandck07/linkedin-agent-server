import express from "express";
import crypto from "crypto";
import Razorpay from "razorpay";
import { protect } from "../middleware/auth.js";
import User from "../models/User.js";
import Subscription from "../models/Subscription.js";
import Coupon from "../models/Coupon.js";
import { PLANS } from "../config/plans.js";

const router = express.Router();

const getRazorpay = () => new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

// GET /api/subscription/plans
router.get("/plans", (_req, res) => {
  const plans = Object.entries(PLANS).map(([id, p]) => ({
    id, ...p,
    price: {
      monthly: p.price.monthly,
      halfyearly: p.price.halfyearly
    }
  }));
  res.json({ plans });
});

// POST /api/subscription/apply-coupon
router.post("/apply-coupon", protect, async (req, res) => {
  const { code, planId, billingCycle } = req.body;
  try {
    const coupon = await Coupon.findOne({ code: code.toUpperCase(), isActive: true });
    if (!coupon) return res.status(404).json({ error: "Invalid coupon code" });
    if (new Date() > coupon.expiryDate) return res.status(400).json({ error: "Coupon has expired" });
    if (coupon.usedCount >= coupon.usageLimit) return res.status(400).json({ error: "Coupon usage limit reached" });
    if (coupon.applicablePlans.length && !coupon.applicablePlans.includes(planId))
      return res.status(400).json({ error: `Coupon not valid for ${planId} plan` });

    const basePrice = PLANS[planId]?.price[billingCycle] || 0;
    const discount = coupon.discountType === "percentage"
      ? Math.round(basePrice * coupon.discountValue / 100)
      : coupon.discountValue;
    const finalPrice = Math.max(0, basePrice - discount);

    res.json({ valid: true, discount, finalPrice, coupon: { code: coupon.code, discountType: coupon.discountType, discountValue: coupon.discountValue } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/subscription/create-order
router.post("/create-order", protect, async (req, res) => {
  const { planId, billingCycle = "monthly", couponCode } = req.body;
  if (!PLANS[planId] || planId === "free") return res.status(400).json({ error: "Invalid plan" });

  try {
    let amount = PLANS[planId].price[billingCycle];
    let couponUsed = null;

    if (couponCode) {
      const coupon = await Coupon.findOne({ code: couponCode.toUpperCase(), isActive: true });
      if (coupon && new Date() <= coupon.expiryDate && coupon.usedCount < coupon.usageLimit) {
        const discount = coupon.discountType === "percentage"
          ? Math.round(amount * coupon.discountValue / 100)
          : coupon.discountValue;
        amount = Math.max(1, amount - discount);
        couponUsed = coupon.code;
      }
    }

    const razorpay = getRazorpay();
    const order = await razorpay.orders.create({
      amount: amount * 100, // paise
      currency: "INR",
      receipt: `rcpt_${req.user._id.toString().slice(-6)}_${Date.now()}`,
      notes: { userId: req.user._id.toString(), planId, billingCycle, couponUsed }
    });

    // Save pending subscription
    await Subscription.findOneAndUpdate(
      { userId: req.user._id, status: "pending" },
      { userId: req.user._id, planType: planId, billingCycle, razorpayOrderId: order.id, status: "pending", couponUsed, amountPaid: amount },
      { upsert: true, new: true }
    );

    res.json({ orderId: order.id, amount, currency: "INR", keyId: process.env.RAZORPAY_KEY_ID, name: req.user.name, email: req.user.email });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/subscription/verify-payment
router.post("/verify-payment", protect, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  try {
    const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`).digest("hex");

    if (expected !== razorpay_signature)
      return res.status(400).json({ error: "Payment verification failed" });

    const sub = await Subscription.findOne({ razorpayOrderId: razorpay_order_id });
    if (!sub) return res.status(404).json({ error: "Order not found" });

    const months = sub.billingCycle === "halfyearly" ? 6 : 1;
    const expiryDate = new Date(Date.now() + months * 30 * 24 * 60 * 60 * 1000);

    sub.razorpayPaymentId = razorpay_payment_id;
    sub.status = "active";
    sub.startDate = new Date();
    sub.expiryDate = expiryDate;
    await sub.save();

    // Update user plan
    await User.findByIdAndUpdate(req.user._id, { plan: sub.planType, planExpiry: expiryDate });

    // Increment coupon usage
    if (sub.couponUsed) await Coupon.findOneAndUpdate({ code: sub.couponUsed }, { $inc: { usedCount: 1 } });

    res.json({ success: true, plan: sub.planType, expiryDate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/subscription/webhook
router.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["x-razorpay-signature"];
  const expected = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(req.body).digest("hex");
  if (sig !== expected) return res.status(400).json({ error: "Invalid signature" });

  const event = JSON.parse(req.body);
  if (event.event === "payment.failed") {
    const orderId = event.payload?.payment?.entity?.order_id;
    if (orderId) Subscription.findOneAndUpdate({ razorpayOrderId: orderId }, { status: "cancelled" }).catch(() => {});
  }
  res.json({ received: true });
});

// GET /api/subscription/my
router.get("/my", protect, async (req, res) => {
  try {
    const sub = await Subscription.findOne({ userId: req.user._id, status: "active" }).sort({ createdAt: -1 });
    const user = await User.findById(req.user._id).select("plan planExpiry");
    res.json({ plan: user.plan, planExpiry: user.planExpiry, subscription: sub });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
