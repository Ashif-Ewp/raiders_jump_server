const WebSocket = require("ws");
const Redis = require("ioredis");
require("dotenv").config();

// Configuration
const CONFIG = {
  redis: {
    host: process.env.REDIS_HOST || "localhost",
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === "true" ? {} : undefined,
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      const delay = Math.min(times * 500, 30000);
      console.log(`Redis retry attempt ${times}, next retry in ${delay}ms`);
      return delay;
    },
    reconnectOnError(err) {
      const targetErrors = ["READONLY", "ECONNRESET", "ETIMEDOUT"];
      return targetErrors.some((e) => err.message.includes(e));
    },
  },
  ws: {
    port: parseInt(process.env.WS_PORT, 10) || 8080,
    heartbeatInterval: 30000,
    clientTimeout: 35000,
  },
  shutdown: {
    timeout: 10000,
  },
};

// State
let isShuttingDown = false;
const clients = new Set();

// Redis setup with error handling
const redis = new Redis(CONFIG.redis);

redis.on("connect", () => {
  console.log("[Redis] Connected successfully");
});

redis.on("ready", () => {
  console.log("[Redis] Ready to accept commands");
});

redis.on("error", (err) => {
  console.error("[Redis] Connection error:", err.message);
});

redis.on("close", () => {
  console.log("[Redis] Connection closed");
});

redis.on("reconnecting", (delay) => {
  console.log(`[Redis] Reconnecting in ${delay}ms...`);
});

// Validate price update message
function validatePriceUpdate(data) {
  if (!data || typeof data !== "object") {
    return { valid: false, error: "Invalid message format" };
  }
  if (data.type !== "price_update") {
    return { valid: false, error: "Unknown message type" };
  }
  if (!data.symbol || typeof data.symbol !== "string") {
    return { valid: false, error: "Invalid or missing symbol" };
  }
  if (
    data.price === undefined ||
    data.price === null ||
    isNaN(Number(data.price))
  ) {
    return { valid: false, error: "Invalid or missing price" };
  }
  // Sanitize symbol (alphanumeric and common separators only)
  if (!/^[A-Za-z0-9_\-:]+$/.test(data.symbol)) {
    return { valid: false, error: "Invalid symbol format" };
  }
  return { valid: true };
}

// Update price in Redis with retry
async function updatePrice(symbol, price, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await redis.set(`price:${symbol}`, String(price));
      return { success: true };
    } catch (err) {
      console.error(
        `[Redis] Set failed (attempt ${attempt}/${retries}):`,
        err.message
      );
      if (attempt === retries) {
        return { success: false, error: "Redis operation failed" };
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}

// WebSocket server setup
const wss = new WebSocket.Server({
  port: CONFIG.ws.port,
  clientTracking: true,
});

console.log(`[WS] Server started on port ${CONFIG.ws.port}`);

// Heartbeat to detect stale connections
function heartbeat() {
  this.isAlive = true;
}

const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("[WS] Terminating stale connection");
      clients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, CONFIG.ws.heartbeatInterval);

wss.on("close", () => {
  clearInterval(heartbeatInterval);
});

wss.on("connection", (ws, req) => {
  if (isShuttingDown) {
    ws.close(1001, "Server shutting down");
    return;
  }

  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log(`[WS] Client connected from ${clientIp}`);

  ws.isAlive = true;
  clients.add(ws);

  ws.on("pong", heartbeat);

  ws.on("message", async (message) => {
    if (isShuttingDown) {
      ws.send(JSON.stringify({ error: "Server shutting down" }));
      return;
    }

    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (err) {
      ws.send(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const validation = validatePriceUpdate(data);
    if (!validation.valid) {
      ws.send(JSON.stringify({ error: validation.error }));
      return;
    }

    const { symbol, price } = data;
    const result = await updatePrice(symbol, price);

    if (result.success) {
      console.log(`[Price] Updated price:${symbol} = ${price}`);
      ws.send(JSON.stringify({ success: true, symbol, price }));
    } else {
      ws.send(JSON.stringify({ success: false, error: result.error }));
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`[WS] Client disconnected from ${clientIp} (code: ${code})`);
    clients.delete(ws);
  });

  ws.on("error", (err) => {
    console.error(`[WS] Error from ${clientIp}:`, err.message);
    clients.delete(ws);
  });
});

wss.on("error", (err) => {
  console.error("[WS] Server error:", err.message);
});

// Graceful shutdown
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[Shutdown] Received ${signal}, starting graceful shutdown...`);

  // Stop accepting new connections
  wss.close(() => {
    console.log("[Shutdown] WebSocket server closed");
  });

  // Close existing connections gracefully
  const closePromises = [];
  clients.forEach((ws) => {
    closePromises.push(
      new Promise((resolve) => {
        ws.send(
          JSON.stringify({ type: "shutdown", message: "Server shutting down" })
        );
        ws.close(1001, "Server shutting down");
        ws.on("close", resolve);
        setTimeout(resolve, 1000);
      })
    );
  });

  // Wait for clients to disconnect (with timeout)
  await Promise.race([
    Promise.all(closePromises),
    new Promise((resolve) => setTimeout(resolve, CONFIG.shutdown.timeout)),
  ]);

  console.log("[Shutdown] All clients disconnected");

  // Close Redis connection
  try {
    await redis.quit();
    console.log("[Shutdown] Redis connection closed");
  } catch (err) {
    console.error("[Shutdown] Error closing Redis:", err.message);
    redis.disconnect();
  }

  console.log("[Shutdown] Graceful shutdown complete");
  process.exit(0);
}

// Handle shutdown signals
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Handle uncaught errors
process.on("uncaughtException", (err) => {
  console.error("[Fatal] Uncaught exception:", err);
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("[Fatal] Unhandled rejection at:", promise, "reason:", reason);
});
