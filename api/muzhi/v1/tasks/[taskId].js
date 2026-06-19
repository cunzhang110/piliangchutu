export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ error: { message: "Method not allowed." } });
    return;
  }

  const apiKey = process.env.MUZHI_API_KEY;
  if (!apiKey) {
    response.status(500).json({ error: { message: "Muzhi API Key is not configured on the server." } });
    return;
  }

  const taskId = String(request.query.taskId || "").trim();
  if (!taskId) {
    response.status(400).json({ error: { message: "Missing Muzhi task id." } });
    return;
  }

  const searchParams = new URLSearchParams();
  Object.entries(request.query || {}).forEach(([key, value]) => {
    if (key === "taskId") return;
    if (Array.isArray(value)) {
      value.forEach(item => searchParams.append(key, item));
      return;
    }
    if (typeof value === "string") {
      searchParams.set(key, value);
    }
  });

  const baseUrl = (process.env.MUZHI_BASE_URL || "https://api.muzhi.ai").replace(/\/$/, "");
  const targetUrl = `${baseUrl}/v1/tasks/${encodeURIComponent(taskId)}${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;

  try {
    const upstream = await fetch(targetUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      }
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
