const readBody = (request) => new Promise((resolve, reject) => {
  const chunks = [];
  request.on("data", chunk => chunks.push(chunk));
  request.on("end", () => resolve(Buffer.concat(chunks)));
  request.on("error", reject);
});

export default async function handler(request, response) {
  const apiKey = process.env.MUZHI_API_KEY;
  if (!apiKey) {
    response.status(500).json({ error: { message: "Muzhi API Key is not configured on the server." } });
    return;
  }

  const baseUrl = (process.env.MUZHI_BASE_URL || "https://api.muzhi.ai").replace(/\/$/, "");
  const rawPath = request.query.path;
  const path = Array.isArray(rawPath) ? rawPath.join("/") : rawPath || "";
  const searchParams = new URLSearchParams();

  Object.entries(request.query || {}).forEach(([key, value]) => {
    if (key === "path") return;
    if (Array.isArray(value)) {
      value.forEach(item => searchParams.append(key, item));
      return;
    }
    if (typeof value === "string") {
      searchParams.set(key, value);
    }
  });

  const targetUrl = `${baseUrl}/${path}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;
  const body = ["GET", "HEAD"].includes(request.method || "GET") ? undefined : await readBody(request);

  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
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
