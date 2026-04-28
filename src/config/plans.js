export const PLANS = {
  free: {
    name: "Free",
    price: { monthly: 0, halfyearly: 0 },
    postsPerMonth: 20,
    schedulesPerMonth: 0,
    peakTimingPerMonth: 0,
    features: { scheduling: false, peakTiming: false, aiGeneration: true, analytics: "basic" }
  },
  pro: {
    name: "Pro",
    price: { monthly: 199, halfyearly: 899 },
    postsPerMonth: 200,
    schedulesPerMonth: 50,
    peakTimingPerMonth: 30,
    features: { scheduling: true, peakTiming: true, aiGeneration: true, analytics: "advanced" }
  },
  premium: {
    name: "Premium",
    price: { monthly: 399, halfyearly: 1699 },
    postsPerMonth: Infinity,
    schedulesPerMonth: Infinity,
    peakTimingPerMonth: Infinity,
    features: { scheduling: true, peakTiming: true, aiGeneration: true, analytics: "advanced" }
  }
};

export const getPlanLimits = (plan) => PLANS[plan] || PLANS.free;
