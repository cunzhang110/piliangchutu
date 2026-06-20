const readBody = (request) => new Promise((resolve, reject) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => resolve(Buffer.concat(chunks)));
  request.on("error", reject);
});

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

  const generationsUrl = process.env.MUZHI_GENERATIONS_URL || "https://api.muzhi.ai/v1/images/generations";
  const body = await readBody(request);

  try {
    const upstream = await fetch(generationsUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": request.headers["content-type"] || "application/json"
      },
      body
    });

    const contentType = upstream.headers.get("content-type") || "application/json; charset=utf-8";
    const upstreamBody = Buffer.from(await upstream.arrayBuffer());

    response.status(upstream.status);
    response.setHeader("Content-Type", contentType);
    response.send(upstreamBody);
  } catch (error) {
    response.status(502).json({
      error: {
        message: error instanceof Error ? error.message : "Muzhi proxy request failed."
      }
    });
  }
}
