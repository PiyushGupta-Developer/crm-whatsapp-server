require("dotenv").config();
const { startReminderScheduler } = require("./reminderScheduler");
const { testDatabaseConnection } = require("./db");
const { startStockReminderScheduler } = require("./stockReminderScheduler");
const express = require("express");

const {
  connectWhatsApp,
  getWhatsAppStatus,
  disconnectWhatsApp,
  sendWhatsAppMessage,
} = require("./whatsapp");

const app = express();

app.use(express.json());

function verifyApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];

  if (!process.env.CRM_API_KEY || apiKey !== process.env.CRM_API_KEY) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized access",
    });
  }

  next();
}

function validateIds(req, res, next) {
  const { organizationId, deviceId } = req.params;

  if (!/^[1-9]\d*$/.test(organizationId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid organization ID",
    });
  }

  if (!/^[1-9]\d*$/.test(deviceId)) {
    return res.status(400).json({
      success: false,
      message: "Invalid device ID",
    });
  }

  next();
}

app.get("/", (req, res) => {
  return res.json({
    success: true,
    message: "CRM WhatsApp Server Running",
  });
});

app.post(
  "/api/whatsapp/:organizationId/devices/:deviceId/connect",
  verifyApiKey,
  validateIds,
  async (req, res) => {
    try {
      const { organizationId, deviceId } = req.params;

      const status = await connectWhatsApp(organizationId, deviceId);

      return res.json({
        success: true,
        organizationId,
        deviceId,
        status,
        message:
          status === "connected"
            ? "WhatsApp already connected"
            : "WhatsApp connection initiated",
      });
    } catch (error) {
      console.error("WhatsApp connection error:", error.message);

      return res.status(500).json({
        success: false,
        message: "Unable to initiate WhatsApp connection",
      });
    }
  },
);

app.get(
  "/api/whatsapp/:organizationId/devices/:deviceId/status",
  verifyApiKey,
  validateIds,
  (req, res) => {
    try {
      const { organizationId, deviceId } = req.params;

      const result = getWhatsAppStatus(organizationId, deviceId);

      return res.json({
        success: true,
        organizationId,
        deviceId,
        ...result,
      });
    } catch (error) {
      console.error("WhatsApp status error:", error.message);

      return res.status(500).json({
        success: false,
        message: "Unable to fetch WhatsApp status",
      });
    }
  },
);

app.post(
  "/api/whatsapp/:organizationId/devices/:deviceId/disconnect",
  verifyApiKey,
  validateIds,
  async (req, res) => {
    try {
      const { organizationId, deviceId } = req.params;

      const result = await disconnectWhatsApp(organizationId, deviceId);

      return res.json({
        ...result,
        organizationId,
        deviceId,
      });
    } catch (error) {
      console.error("WhatsApp disconnect error:", error.message);

      return res.status(500).json({
        success: false,
        message: "Unable to disconnect WhatsApp",
      });
    }
  },
);

const PORT = process.env.PORT || 3001;

app.post(
  "/api/whatsapp/:organizationId/devices/:deviceId/send-message",
  verifyApiKey,
  validateIds,
  async (req, res) => {
    try {
      const { organizationId, deviceId } = req.params;
      const { phone, message } = req.body;

      if (!phone || !message) {
        return res.status(400).json({
          success: false,
          message: "Phone and message are required",
        });
      }

      const result = await sendWhatsAppMessage(
        organizationId,
        deviceId,
        phone,
        message,
      );

      return res.json(result);
    } catch (error) {
      console.error("WhatsApp send error:", error.message);

      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  },
);


// app.listen(PORT, "127.0.0.1", () => {
//   console.log(`Server running at http://localhost:${PORT}`);

//   // Verify MySQL connection and package expiry date
//   testDatabaseConnection().catch((error) => {
//     console.error("[MySQL] Connection check failed:", error.message);
//   });

//   // Start existing schedulers
//   startReminderScheduler();
//   startStockReminderScheduler();
// });

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);

  // Verify MySQL connection
  testDatabaseConnection().catch((error) => {
    console.error("[MySQL] Connection check failed:", error.message);
  });

  // Start existing schedulers
  startReminderScheduler();
  startStockReminderScheduler();
});
