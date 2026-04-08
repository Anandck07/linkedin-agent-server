import Groq from "groq-sdk";

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
  const [hook, content, hashtags] = await Promise.all([
    hookAgent(groqApiKey, topic),
    contentAgent(groqApiKey, topic),
    hashtagAgent(groqApiKey, topic)
  ]);

  const rawPost = `${hook}\n\n${content}\n\n${hashtags}`;
  const improvedPost = await qualityAgent(groqApiKey, rawPost);
  const compliance = await complianceAgent(groqApiKey, improvedPost);

  if (!compliance.safe) throw new Error(`Post failed compliance: ${compliance.reason}`);
  return improvedPost;
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
