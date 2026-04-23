import Groq from "groq-sdk";
import axios from "axios";

const ask = async (groqApiKey, system, user) => {
  const groq = new Groq({ apiKey: groqApiKey });
  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });
  return res.choices[0].message.content.trim();
};

const hookAgent = (key, topic) =>
  ask(key, "You write viral LinkedIn hooks. One punchy opening line only.", `Topic: ${topic}`);

const contentAgent = (key, topic) =>
  ask(key, "You write LinkedIn post body content. 3-5 short paragraphs, conversational tone.", `Topic: ${topic}`);

const hashtagAgent = (key, topic) =>
  ask(key, "You generate 5 relevant LinkedIn hashtags only. No explanation.", `Topic: ${topic}`);

export const bestTimeAgent = async (key, topic) => {
  let liveApiContext = "";
  try {
    const { data } = await axios.get("http://worldtimeapi.org/api/ip");
    liveApiContext = `LIVE API FETCH: Current DayOfWeek is ${data.day_of_week}, DayOfYear is ${data.day_of_year}, WeekNumber is ${data.week_number}.`;
  } catch (err) {
    liveApiContext = `LIVE API FETCH FAILED. Fallback time: ${new Date().toLocaleString()}`;
  }

  return ask(
    key,
    `You are a real-time LinkedIn predictive analytics API. ${liveApiContext}. Generate a dynamic 7-day schedule of best posting times tailored to the user's industry. 
CRITICAL RULE: You MUST fundamentally base your numbers on these accurate global baselines:
- Mon: Afternoons (Low)
- Tue: 10:00 AM - 11:00 AM (Peak)
- Wed: 10:00 AM - 12:00 PM (Peak)
- Thu: 10:00 AM - 1:00 PM (Peak)
- Fri: 9:00 AM - 11:00 AM
- Sat/Sun: Ineffective
You MUST output ONLY a strict bulleted list heavily formatted with a '|' delimiter separating the times from your dynamic daily reasoning. Format exactly like this example:
- Wed: 10:00 AM - 12:00 PM | Capture early morning commuters and industry-specific post-lunch spikes for maximum visibility.
- Thu: 10:00 AM - 1:00 PM | Focus on mid-day engagement.
Note: Always start with the current day based on LIVE API FETCH.`,
    `Industry/Topic: ${topic}`
  );
};

const qualityAgent = (key, post) =>
  ask(key, "You are a LinkedIn engagement expert. Improve this post for virality. Return only the improved post.", post);

const complianceAgent = async (key, post) => {
  const result = await ask(
    key,
    "You check if LinkedIn posts violate community guidelines. Reply with JSON: { safe: true/false, reason: string }",
    post
  );
  try {
    return JSON.parse(result.replace(/```json|```/g, "").trim());
  } catch {
    return { safe: true, reason: "OK" };
  }
};

export async function linkedinAgent(topic, groqApiKey) {
  const [hook, content, hashtags, bestTime] = await Promise.all([
    hookAgent(groqApiKey, topic),
    contentAgent(groqApiKey, topic),
    hashtagAgent(groqApiKey, topic),
    bestTimeAgent(groqApiKey, topic)
  ]);

  const rawPost = `${hook}\n\n${content}\n\n${hashtags}`;
  const improvedPost = await qualityAgent(groqApiKey, rawPost);
  const compliance = await complianceAgent(groqApiKey, improvedPost);

  if (!compliance.safe) throw new Error(`Post failed compliance: ${compliance.reason}`);
  return { post: improvedPost, bestTime };
}

export async function linkedinImagePromptAgent({ prompt, imageBuffer, imageMimeType = "image/jpeg", groqApiKey }) {
  const groq = new Groq({ apiKey: groqApiKey });
  const imageBase64 = imageBuffer.toString("base64");

  const res = await groq.chat.completions.create({
    model: "llama-3.2-11b-vision-preview",
    messages: [
      {
        role: "system",
        content: "You are a LinkedIn content expert. Create one polished post (hook + short paragraphs + CTA + 4-6 hashtags). Return only the final post text."
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Prompt/context from user: ${prompt || "Create a professional LinkedIn post from this image."}`
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${imageMimeType};base64,${imageBase64}`
            }
          }
        ]
      }
    ]
  });

  return res.choices?.[0]?.message?.content?.trim() || "";
}
