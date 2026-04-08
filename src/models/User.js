import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const postSchema = new mongoose.Schema({
  topic: String,
  content: String,
  image: String,
  postedToLinkedIn: { type: Boolean, default: false },
  scheduleStatus: {
    type: String,
    enum: ["draft", "scheduled", "retrying", "posting", "posted", "failed"],
    default: "draft"
  },
  scheduledFor: Date,
  scheduleAttempts: { type: Number, default: 0 },
  lastScheduleError: String,
  publishedAt: Date,
  linkedinPostUrn: String,
  likesCount: { type: Number, default: 0 },
  commentsCount: { type: Number, default: 0 },
  metricsUpdatedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: String,
  credentials: {
    groqApiKey: String,
    linkedinClientId: String,
    linkedinClientSecret: String,
    linkedinRedirectUri: String
  },
  linkedinAccessToken: String,
  linkedinRefreshToken: String,
  linkedinTokenExpiresAt: Date,
  linkedinPersonId: String,
  resetToken: String,
  resetTokenExpiry: Date,
  posts: [postSchema]
}, { timestamps: true });

userSchema.pre("save", async function () {
  if (this.isModified("password"))
    this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.matchPassword = function (pass) {
  return bcrypt.compare(pass, this.password);
};

export default mongoose.model("User", userSchema);
