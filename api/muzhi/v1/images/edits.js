const readJsonBody = (request) => new Promise((resolve, reject) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => {
    try {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      resolve(rawBody ? JSON.parse(rawBody) : {});
    } catch (error) {
      reject(error);
    }
  });
  request.on("error", reject);
});

const dataUrlToFile = (dataUrl, filename) => {
  const matched = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/);
  if (!matched) return null;

  const mimeType = matched[1] || "image/png";
  const bytes = Buffer.from(matched[2], "base64");
  const extension = mimeType.split("/")[1] || "png";
  return new File([bytes], `${filename}.${extension}`, { type: mimeType });
};

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: { message: "Method not allowed." } });
    return;
  }

  const apiKey = process.env.MUZHI_API_KEY;
  if (!apiKey) {
    response.status(500).json({ error: { message: "Muzhi API Key is not configured on the server." } });
    return;
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    response.status(400).json({ error: { message: "Invalid JSON body for Muzhi edits proxy." } });
    return;
  }

  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length === 0) {
    response.status(400).json({ error: { message: "Muzhi edits requires at least one reference image." } });
    return;
  }

  const formData = new FormData();
  formData.set("model", body.model || "gpt-image-2");
  formData.set("prompt", body.prompt || "");
  formData.set("n", String(body.n || 1));
  if (body.size) formData.set("size", body.size);
  if (body.quality) formData.set("quality", body.quality);
  if (body.background) formData.set("background", body.background);
  if (body.input_fidelity) formData.set("input_fidelity", body.input_fidelity);
  if (body.output_format) formData.set("output_format", body.output_format);
  if (body.moderation) formData.set("moderation", body.moderation);

  images.forEach((imageDataUrl, index) => {
    const imageFile = dataUrlToFile(imageDataUrl, `reference-${index + 1}`);
    if (imageFile) {
      formData.append("image", imageFile);
    }
  });

  const editsUrl = process.env.MUZHI_EDITS_URL || "https://api.muzhi.ai/v1/images/edits";

  try {
    const upstream = await fetch(editsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: formData
    });

    const contentType = upstream.headers.get("content-type") || "application/json; charset=utf-8";
    const upstreamBody = Buffer.from(await upstream.arrayBuffer());

    response.status(upstream.status);
    response.setHeader("Content-Type", contentType);
    response.send(upstreamBody);
  } catch (error) {
    response.status(502).json({
      error: {
        message: error instanceof Error ? error.message : "Muzhi edits proxy request failed."
      }
    });
  }
}
