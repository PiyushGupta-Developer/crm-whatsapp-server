const baileys = require("@whiskeysockets/baileys");
const pino = require("pino");
const path = require("path");
const fs = require("fs/promises");

const makeWASocket = baileys.default;

const { useMultiFileAuthState, DisconnectReason } = baileys;

const sessions = new Map();
const reconnectTimers = new Map();
const disconnecting = new Set();

function validateId(value, label) {
  const id = String(value ?? "");

  if (!/^[1-9]\d*$/.test(id)) {
    throw new Error(`Invalid ${label}`);
  }

  return id;
}

function getSessionKey(organizationId, deviceId) {
  const orgId = validateId(organizationId, "organization ID");

  const devId = validateId(deviceId, "device ID");

  return `organization_${orgId}_device_${devId}`;
}

function getAuthPath(organizationId, deviceId) {
  return path.join(
    __dirname,
    "auth_info",
    getSessionKey(organizationId, deviceId),
  );
}

function clearReconnectTimer(sessionKey) {
  const timer = reconnectTimers.get(sessionKey);

  if (timer) {
    clearTimeout(timer);
    reconnectTimers.delete(sessionKey);
  }
}

function scheduleReconnect(organizationId, deviceId, sessionKey) {
  if (disconnecting.has(sessionKey) || reconnectTimers.has(sessionKey)) {
    return;
  }

  const timer = setTimeout(async () => {
    reconnectTimers.delete(sessionKey);

    if (disconnecting.has(sessionKey)) {
      return;
    }

    try {
      await connectWhatsApp(organizationId, deviceId);
    } catch (error) {
      console.error(`Reconnect failed for ${sessionKey}:`, error.message);

      scheduleReconnect(organizationId, deviceId, sessionKey);
    }
  }, 5000);

  reconnectTimers.set(sessionKey, timer);
}

async function connectWhatsApp(organizationId, deviceId) {
  const sessionKey = getSessionKey(organizationId, deviceId);

  if (disconnecting.has(sessionKey)) {
    throw new Error("Device disconnect is in progress");
  }

  const existing = sessions.get(sessionKey);

  if (existing) {
    return existing.status;
  }

  clearReconnectTimer(sessionKey);

  const session = {
    status: "connecting",
    qr: null,
    socket: null,
    intentionalDisconnect: false,
  };

  sessions.set(sessionKey, session);

  const authPath = getAuthPath(organizationId, deviceId);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    if (session.intentionalDisconnect || disconnecting.has(sessionKey)) {
      return "disconnected";
    }

    const sock = makeWASocket({
      auth: state,
      logger: pino({
        level: "silent",
      }),
    });

    session.socket = sock;

    sock.ev.on("creds.update", async () => {
      if (session.intentionalDisconnect || disconnecting.has(sessionKey)) {
        return;
      }

      await saveCreds();
    });

    sock.ev.on("connection.update", (update) => {
      if (
        session.intentionalDisconnect ||
        disconnecting.has(sessionKey) ||
        sessions.get(sessionKey) !== session
      ) {
        return;
      }

      const { connection, qr, lastDisconnect } = update;

      if (qr) {
        session.qr = qr;
        session.status = "qr_ready";

        console.log(`QR ready for ${sessionKey}`);
      }

      if (connection === "open") {
        session.status = "connected";
        session.qr = null;

        clearReconnectTimer(sessionKey);

        console.log(`${sessionKey} connected`);
      }

      if (connection === "close") {
        session.status = "disconnected";
        session.qr = null;

        sessions.delete(sessionKey);

        const code = lastDisconnect?.error?.output?.statusCode;

        console.log(`${sessionKey} disconnected: ${code ?? "unknown"}`);

        if (code !== DisconnectReason.loggedOut) {
          scheduleReconnect(organizationId, deviceId, sessionKey);
        }
      }
    });

    return session.status;
  } catch (error) {
    if (sessions.get(sessionKey) === session) {
      sessions.delete(sessionKey);
    }

    if (!disconnecting.has(sessionKey)) {
      throw error;
    }

    return "disconnected";
  }
}

function getWhatsAppStatus(organizationId, deviceId) {
  const sessionKey = getSessionKey(organizationId, deviceId);

  const session = sessions.get(sessionKey);

  return {
    status: session?.status || "disconnected",
    qr: session?.qr || null,
  };
}

async function disconnectWhatsApp(organizationId, deviceId) {
  const sessionKey = getSessionKey(organizationId, deviceId);

  if (disconnecting.has(sessionKey)) {
    throw new Error("Device disconnect is already in progress");
  }

  disconnecting.add(sessionKey);
  clearReconnectTimer(sessionKey);

  const session = sessions.get(sessionKey);

  if (session) {
    session.intentionalDisconnect = true;
    session.status = "disconnected";
    session.qr = null;
  }

  try {
    if (session?.socket) {
      try {
        await session.socket.logout();
      } catch (error) {
        console.error(`Logout error for ${sessionKey}:`, error.message);
      }

      try {
        session.socket.end(new Error("Device disconnected by user"));
      } catch (error) {
        console.error(`Socket close error for ${sessionKey}:`, error.message);
      }
    }

    sessions.delete(sessionKey);

    await fs.rm(getAuthPath(organizationId, deviceId), {
      recursive: true,
      force: true,
    });

    console.log(`${sessionKey} removed`);

    return {
      success: true,
      status: "disconnected",
      message: "WhatsApp device disconnected",
    };
  } finally {
    disconnecting.delete(sessionKey);
  }
}


async function sendWhatsAppMessage(organizationId, deviceId, phone, message) {
  const sessionKey = getSessionKey(organizationId, deviceId);
  const session = sessions.get(sessionKey);

  if (!session || session.status !== "connected" || !session.socket) {
    throw new Error("WhatsApp device is not connected");
  }

  let number = String(phone || "").replace(/\D/g, "");

  // Indian number without country code
  if (number.length === 10) {
    number = "91" + number;
  }

  if (number.length < 11 || number.length > 15) {
    throw new Error("Invalid customer phone number");
  }

  if (!message || !String(message).trim()) {
    throw new Error("Message cannot be empty");
  }

  const jid = `${number}@s.whatsapp.net`;

  const result = await session.socket.sendMessage(jid, {
    text: String(message).trim(),
  });

  return {
    success: true,
    messageId: result?.key?.id || null,
  };
}

module.exports = {
  connectWhatsApp,
  getWhatsAppStatus,
  disconnectWhatsApp,
  sendWhatsAppMessage,
};
