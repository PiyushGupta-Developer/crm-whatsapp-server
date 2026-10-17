const { pool } = require("./db");

const { getWhatsAppStatus, sendWhatsAppMessage } = require("./whatsapp");

let started = false;
let busy = false;

async function processLowStockReminders() {
  if (busy) return;

  busy = true;

  try {
    const [parts] = await pool.query(`
      SELECT
        id,
        organization_id,
        part_name,
        sku,
        opening_stock,
        low_stock_units,
        unit_type
      FROM parts
      WHERE manage_stock = 1
        AND low_stock_alert = 1
        AND opening_stock <= low_stock_units
        AND low_stock_notified = 0
      ORDER BY organization_id, id
      LIMIT 20
    `);

    for (const part of parts) {
      try {
        // Find the admin's customer_id for this organization.
        const [admins] = await pool.query(
          `SELECT customer_id
           FROM users
           WHERE organization_id = ?
             AND role = 'admin'
           ORDER BY id ASC
           LIMIT 1`,
          [part.organization_id],
        );

        const customerId = admins[0]?.customer_id;

        if (!customerId) {
          console.error(
            `[Stock Reminder] Admin not found for organization ${part.organization_id}`,
          );
          continue;
        }

        // Get the recipient number from the client's contact field.
        const [clientRows] = await pool.query(
          `SELECT contact
           FROM client_services
           WHERE organization_id = ?
             AND client_id = ?
           LIMIT 1`,
          [part.organization_id, customerId],
        );

        const recipient = String(clientRows[0]?.contact || "").replace(
          /\D/g,
          "",
        );

        if (!recipient) {
          console.error(
            `[Stock Reminder] Admin contact missing for organization ${part.organization_id}`,
          );
          continue;
        }

        // Find a connected WhatsApp device for this organization.
        const [devices] = await pool.query(
          `SELECT id
           FROM whatsapp_devices
           WHERE organization_id = ?
           ORDER BY id ASC`,
          [part.organization_id],
        );

        let deviceId = null;

        for (const device of devices) {
          const status = getWhatsAppStatus(
            String(part.organization_id),
            String(device.id),
          );

          if (status.status === "connected") {
            deviceId = String(device.id);
            break;
          }
        }

        if (!deviceId) {
          console.error(
            `[Stock Reminder] No connected device for organization ${part.organization_id}`,
          );
          continue;
        }

        const unit = part.unit_type || "";

        const message = [
          "⚠️ LOW STOCK ALERT",
          "",
          `Item: ${part.part_name}`,
          `SKU: ${part.sku || "N/A"}`,
          `Current Stock: ${part.opening_stock} ${unit}`.trim(),
          `Minimum Stock: ${part.low_stock_units} ${unit}`.trim(),
          "",
          "Please arrange stock replenishment.",
        ].join("\n");

        const result = await sendWhatsAppMessage(
          String(part.organization_id),
          deviceId,
          recipient,
          message,
        );

        if (!result || result.success !== true) {
          throw new Error("WhatsApp send was not confirmed");
        }

        // Mark this item notified only after successful send response.
        const [updated] = await pool.query(
          `UPDATE parts
           SET low_stock_notified = 1
           WHERE id = ?
             AND organization_id = ?
             AND low_stock_notified = 0
             AND manage_stock = 1
             AND low_stock_alert = 1
             AND opening_stock <= low_stock_units`,
          [part.id, part.organization_id],
        );

        console.log(
          `[Stock Reminder] Item ${part.id}: send accepted; alert flag updated: ${updated.affectedRows === 1}`,
        );
      } catch (error) {
        console.error(
          `[Stock Reminder] Item ${part.id} failed:`,
          error.message,
        );
      }
    }

    // Allow a new alert if stock recovers or alerts are disabled.
    await pool.query(`
      UPDATE parts
      SET low_stock_notified = 0
      WHERE opening_stock > low_stock_units
         OR manage_stock = 0
         OR low_stock_alert = 0
    `);
  } catch (error) {
    console.error("[Stock Reminder] Database error:", error.message);
  } finally {
    busy = false;
  }
}

function startStockReminderScheduler() {
  if (started) return;

  started = true;

  console.log("[Stock Reminder] Started. Checking every 30 seconds.");

  processLowStockReminders();
  setInterval(processLowStockReminders, 30000);
}

module.exports = {
  startStockReminderScheduler,
  processLowStockReminders,
};
