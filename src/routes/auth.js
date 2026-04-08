import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

const router = express.Router();

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "7d" });

router.post("/register", async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const user = await User.create({ name, email, password });
    res.json({ token: signToken(user._id), user: { id: user._id, name, email } });
  } catch (err) {
    res.status(400).json({ error: err.code === 11000 ? "Email already exists" : err.message });
  }
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user || !(await user.matchPassword(password)))
      return res.status(401).json({ error: "Invalid credentials" });
    res.json({ token: signToken(user._id), user: { id: user._id, name: user.name, email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
