import axios from "axios";

const REDIRECT_URI = process.env.LINKEDIN_REDIRECT_URI || "https://linkedin-agent-client-git-main-anands-projects-d6093bf1.vercel.app/auth/linkedin/callback";

export const getAuthUrl = ({ linkedinClientId }) =>
  `https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${linkedinClientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=openid%20profile%20w_member_social`;

export const getAccessToken = async (code, { linkedinClientId, linkedinClientSecret }) => {
  const { data } = await axios.post(
    "https://www.linkedin.com/oauth/v2/accessToken",
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: linkedinClientId,
      client_secret: linkedinClientSecret
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return data;
};

export const refreshAccessToken = async (refreshToken, { linkedinClientId, linkedinClientSecret }) => {
  const { data } = await axios.post(
    "https://www.linkedin.com/oauth/v2/accessToken",
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: linkedinClientId,
      client_secret: linkedinClientSecret
    }),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  return data;
};

export const ensureFreshLinkedInToken = async (user) => {
  if (!user.linkedinAccessToken) throw new Error("LinkedIn not connected");

  const expiresAt = user.linkedinTokenExpiresAt ? new Date(user.linkedinTokenExpiresAt).getTime() : null;
  const refreshBufferMs = 60 * 1000;
  if (!expiresAt || expiresAt > Date.now() + refreshBufferMs) return user.linkedinAccessToken;

  if (!user.linkedinRefreshToken)
    throw new Error("LinkedIn token expired. Please reconnect your LinkedIn account.");

  const data = await refreshAccessToken(user.linkedinRefreshToken, user.credentials || {});
  user.linkedinAccessToken = data.access_token;
  if (data.refresh_token) user.linkedinRefreshToken = data.refresh_token;
  if (data.expires_in) user.linkedinTokenExpiresAt = new Date(Date.now() + data.expires_in * 1000);
  await user.save();

  return user.linkedinAccessToken;
};

export const getProfile = async (accessToken) => {
  const { data } = await axios.get("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return data;
};

const uploadImage = async (accessToken, personId, imageBuffer) => {
  const { data: reg } = await axios.post(
    "https://api.linkedin.com/v2/assets?action=registerUpload",
    {
      registerUploadRequest: {
        owner: `urn:li:person:${personId}`,
        recipes: ["urn:li:digitalmediaRecipe:feedshare-image"],
        serviceRelationships: [{ identifier: "urn:li:userGeneratedContent", relationshipType: "OWNER" }]
      }
    },
    { headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" } }
  );
  const uploadUrl = reg.value.uploadMechanism["com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest"].uploadUrl;
  const asset = reg.value.asset;
  await axios.put(uploadUrl, imageBuffer, {
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "image/jpeg" }
  });
  return asset;
};

export const postToLinkedIn = async (accessToken, personId, text, imageBuffer = null) => {
  let mediaCategory = "NONE";
  let media = [];
  if (imageBuffer) {
    const asset = await uploadImage(accessToken, personId, imageBuffer);
    mediaCategory = "IMAGE";
    media = [{ status: "READY", media: asset }];
  }
  const response = await axios.post(
    "https://api.linkedin.com/v2/ugcPosts",
    {
      author: `urn:li:person:${personId}`,
      lifecycleState: "PUBLISHED",
      specificContent: {
        "com.linkedin.ugc.ShareContent": {
          shareCommentary: { text },
          shareMediaCategory: mediaCategory,
          ...(media.length && { media })
        }
      },
      visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" }
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "X-Restli-Protocol-Version": "2.0.0",
        "Content-Type": "application/json"
      }
    }
  );

  return response.headers?.["x-restli-id"] || response.data?.id || null;
};

export const getLinkedInPostMetrics = async (accessToken, postUrn) => {
  if (!postUrn) return { likes: 0, comments: 0 };

  const encodedUrn = encodeURIComponent(postUrn);
  const { data } = await axios.get(`https://api.linkedin.com/v2/socialActions/${encodedUrn}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Restli-Protocol-Version": "2.0.0"
    }
  });

  return {
    likes: data?.likesSummary?.totalLikes || 0,
    comments: data?.commentsSummary?.totalFirstLevelComments || 0
  };
};
