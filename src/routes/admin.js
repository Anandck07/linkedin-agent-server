import express from "express";
import { protect } from "../middleware/auth.js";
import { requireAdmin } from "../middleware/limits.js";
import User from "../models/User.js";
import Subscription from "../models/Subscription.js";
import Coupon from "../models/Coupon.js";
import UsageTracking from "../models/UsageTracking.js";

const router = express.Router();
router.use(protect, requireAdmin);

// GET /api/admin/stats
router.get("/stats", async (_req, res) => {
  try {
    const [totalUsers, activeSubscriptions, revenue] = await Promise.all([
      User.countDocuments(),
      Subscription.countDocuments({ status: "active" }),
      Subscription.aggregate([{ $match: { status: "active" } }, { $group: { _id: null, total: { $sum: "$amountPaid" } } }])
    ]);
    const revenueTotal = revenue[0]?.total || 0;
    const planBreakdown = await User.aggregate([{ $group: { _id: "$plan", count: { $sum: 1 } } }]);
    res.json({ totalUsers, activeSubscriptions, revenue: revenueTotal, planBreakdown });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/users
router.get("/users", async (_req, res) => {
  try {
    const users = await User.find().select("-password -posts").sort({ createdAt: -1 }).limit(100);
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/coupons
router.get("/coupons", async (_req, res) => {
  const coupons = await Coupon.find().sort({ createdAt: -1 });
  res.json({ coupons });
});

// POST /api/admin/coupons
router.post("/coupons", async (req, res) => {
  try {
    const { code, discountType, discountValue, expiryDate, usageLimit, applicablePlans } = req.body;
    const coupon = await Coupon.create({ code: code.toUpperCase(), discountType, discountValue, expiryDate, usageLimit, applicablePlans: applicablePlans || ["pro", "premium"] });
    res.json({ success: true, coupon });
  } catch (err) {
    res.status(400).json({ error: err.code === 11000 ? "Coupon code already exists" : err.message });
  }
});

// PUT /api/admin/coupons/:id
router.put("/coupons/:id", async (req, res) => {
  try {
    const coupon = await Coupon.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json({ success: true, coupon });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/coupons/:id
router.delete("/coupons/:id", async (req, res) => {
  await Coupon.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

// PUT /api/admin/users/:id/plan
router.put("/users/:id/plan", async (req, res) => {
  try {
    const { plan, planExpiry } = req.body;
    const user = await User.findByIdAndUpdate(req.params.id, { plan, planExpiry }, { new: true }).select("-password -posts");
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
