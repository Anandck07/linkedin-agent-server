import mongoose from "mongoose";

const subscriptionSchema = new mongoose.Schema({
  userId:           { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  planType:         { type: String, enum: ["free", "pro", "premium"], default: "free" },
  billingCycle:     { type: String, enum: ["monthly", "halfyearly"], default: "monthly" },
  razorpayOrderId:  String,
  razorpayPaymentId:String,
  status:           { type: String, enum: ["active", "expired", "cancelled", "pending"], default: "pending" },
  startDate:        { type: Date, default: Date.now },
  expiryDate:       Date,
  couponUsed:       String,
  amountPaid:       Number,
}, { timestamps: true });

export default mongoose.model("Subscription", subscriptionSchema);
