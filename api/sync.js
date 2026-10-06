const allowedCollections = new Set(["sites", "incidents", "accidents"]);
const keyFor = (collection) => `dhre:dashboard:${collection}`;

async function redisCommand(command) {
  const response = await fetch(process.env.KV_REST_API_URL || process.env.REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`Redis request failed: ${response.status}`);
  const data = await response.json();
  if (data.error) throw new Error(data.error);
  return data.result;
}

function send(res, status, body) {
  res.status(status).json(body);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const collection = req.method === "GET" ? req.query.collection : req.body?.collection;
  if (!allowedCollections.has(collection)) return send(res, 400, { error: "Invalid collection" });

  try {
    if (req.method === "GET") {
      const stored = await redisCommand(["GET", keyFor(collection)]);
      if (!stored) return send(res, 200, { payload: null, rev: 0 });
      const parsed = JSON.parse(stored);
      return send(res, 200, parsed);
    }

    if (req.method === "POST") {
      if (!Array.isArray(req.body?.payload)) return send(res, 400, { error: "Payload must be an array" });
      const rev = await redisCommand(["INCR", `${keyFor(collection)}:rev`]);
      const value = JSON.stringify({ payload: req.body.payload, rev: Number(rev) });
      await redisCommand(["SET", keyFor(collection), value]);
      return send(res, 200, { rev: Number(rev) });
    }

    return send(res, 405, { error: "Method not allowed" });
  } catch (error) {
    return send(res, 500, { error: "Database unavailable" });
  }
}
