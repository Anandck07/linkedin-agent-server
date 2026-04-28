import mongoose from "mongoose";

const usageSchema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
  postsUsed:      { type: Number, default: 0 },
  schedulesUsed:  { type: Number, default: 0 },
  peakTimingUsed: { type: Number, default: 0 },
  resetDate:      { type: Date, default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
}, { timestamps: true });

export default mongoose.model("UsageTracking", usageSchema);
