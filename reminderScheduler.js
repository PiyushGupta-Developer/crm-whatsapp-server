const { pool } = require("./db");

const { getWhatsAppStatus, sendWhatsAppMessage } = require("./whatsapp");

let schedulerStarted = false;
let schedulerBusy = false;

async function processDueReminders() {
  if (schedulerBusy) return;

  schedulerBusy = true;

  try {
    const [reminders] = await pool.query(
      `SELECT id, organization_id, sale_id, customer_id,
              phone_number, message, scheduled_at
       FROM invoice_whatsapp_reminders
       WHERE status = 'pending'
         AND scheduled_at <= NOW()
       ORDER BY scheduled_at ASC
       LIMIT 10`,
    );

    for (const reminder of reminders) {
      try {
        // Claim this reminder so another scheduler cannot send it too.
        const [claim] = await pool.query(
          `UPDATE invoice_whatsapp_reminders
           SET status = 'sending',
               attempts = attempts + 1,
               last_error = NULL
           WHERE id = ?
             AND status = 'pending'
             AND scheduled_at <= NOW()`,
          [reminder.id],
        );

        if (claim.affectedRows !== 1) {
          continue;
        }

        console.log(`[Reminder Scheduler] Processing reminder #${reminder.id}`);

        // Find devices belonging to this organization.
        const [devices] = await pool.query(
          `SELECT id
           FROM whatsapp_devices
           WHERE organization_id = ?
           ORDER BY id ASC`,
          [reminder.organization_id],
        );

        let connectedDeviceId = null;

        for (const device of devices) {
          const deviceStatus = getWhatsAppStatus(
            String(reminder.organization_id),
            String(device.id),
          );

          if (deviceStatus.status === "connected") {
            connectedDeviceId = String(device.id);
            break;
          }
        }

        if (!connectedDeviceId) {
          throw new Error(
            "No connected WhatsApp device found for this organization",
          );
        }

        const result = await sendWhatsAppMessage(
          String(reminder.organization_id),
          connectedDeviceId,
          reminder.phone_number,
          reminder.message,
        );

        if (!result || result.success !== true) {
          throw new Error("WhatsApp message sending was not confirmed");
        }

        await pool.query(
          `UPDATE invoice_whatsapp_reminders
           SET status = 'sent',
               sent_at = NOW(),
               last_error = NULL
           WHERE id = ?
             AND status = 'sending'`,
          [reminder.id],
        );

        console.log(
          `[Reminder Scheduler] Reminder #${reminder.id} sent successfully`,
        );
      } catch (error) {
        console.error(
          `[Reminder Scheduler] Reminder #${reminder.id} failed:`,
          error.message,
        );

        try {
          await pool.query(
            `UPDATE invoice_whatsapp_reminders
             SET status = 'failed',
                 last_error = ?
             WHERE id = ?
               AND status = 'sending'`,
            [String(error.message).slice(0, 2000), reminder.id],
          );
        } catch (dbError) {
          console.error(
            `[Reminder Scheduler] Could not update reminder #${reminder.id}:`,
            dbError.message,
          );
        }
      }
    }
  } catch (error) {
    console.error("[Reminder Scheduler] Database error:", error.message);
  } finally {
    schedulerBusy = false;
  }
}
// Add this function after processDueReminders()

let leadSchedulerBusy = false;

async function processDueLeadReminders() {
  if (leadSchedulerBusy) return;

  leadSchedulerBusy = true;

  try {
    const [leads] = await pool.query(`
      SELECT
        l.id,
        l.organization_id,
        l.lead_name,
        l.mobile,
        l.next_followup,
        l.employee_id,
        l.assignee
      FROM leads l
      WHERE l.next_followup IS NOT NULL
        AND l.next_followup <= NOW()
        AND l.reminder_status = 'pending'
      ORDER BY l.next_followup ASC
      LIMIT 10
    `);

    for (const lead of leads) {
      try {
        // Claim this lead reminder before sending.
        const [claim] = await pool.query(
          `UPDATE leads
           SET reminder_status = 'sending',
               reminder_error = NULL
           WHERE id = ?
             AND organization_id = ?
             AND reminder_status = 'pending'
             AND next_followup = ?
             AND next_followup <= NOW()`,
          [
            lead.id,
            lead.organization_id,
            lead.next_followup,
          ],
        );

        if (claim.affectedRows !== 1) continue;

        // Get Admin WhatsApp contacts for this organization.
        const [admins] = await pool.query(
          `SELECT cs.contact AS phone
           FROM users u
           INNER JOIN client_services cs
             ON cs.client_id = u.customer_id
            AND cs.organization_id = u.organization_id
           WHERE u.organization_id = ?
             AND u.role = 'admin'
             AND cs.contact IS NOT NULL
             AND cs.contact <> ''`,
          [lead.organization_id],
        );

        // Get assigned employee's number.
        const [employees] = await pool.query(
          `SELECT COALESCE(
              NULLIF(e.mobile_number, ''),
              e.phone_number
           ) AS phone
           FROM employees e
           WHERE e.id = ?
             AND e.organization_id = ?
           LIMIT 1`,
          [lead.employee_id, lead.organization_id],
        );

        // Normalize and deduplicate recipient numbers.
        const recipientMap = new Map();

        for (const row of [...admins, ...employees]) {
          const phone = String(row.phone || '').replace(/\D/g, '');

          if (phone.length >= 10) {
            recipientMap.set(phone, phone);
          }
        }

        if (recipientMap.size === 0) {
          throw new Error(
            'No valid Admin or assigned Employee WhatsApp number found',
          );
        }

        // Find a connected device for this organization.
        const [devices] = await pool.query(
          `SELECT id
           FROM whatsapp_devices
           WHERE organization_id = ?
           ORDER BY id ASC`,
          [lead.organization_id],
        );

        let connectedDeviceId = null;

        for (const device of devices) {
          const deviceStatus = getWhatsAppStatus(
            String(lead.organization_id),
            String(device.id),
          );

          if (deviceStatus.status === 'connected') {
            connectedDeviceId = String(device.id);
            break;
          }
        }

        if (!connectedDeviceId) {
          throw new Error(
            'No connected WhatsApp device found for this organization',
          );
        }

        const followupDate = new Date(lead.next_followup)
          .toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
          });

        const message =
          `Lead Follow-up Reminder\n\n` +
          `Lead: ${lead.lead_name}\n` +
          `Mobile: ${lead.mobile || 'Not provided'}\n` +
          `Assigned Employee: ${lead.assignee || 'Not assigned'}\n` +
          `Follow-up: ${followupDate}\n\n` +
          `Please follow up on this lead.`;

        const errors = [];

        for (const phone of recipientMap.values()) {
          try {
            const result = await sendWhatsAppMessage(
              String(lead.organization_id),
              connectedDeviceId,
              phone,
              message,
            );

            if (!result || result.success !== true) {
              throw new Error('WhatsApp sending was not confirmed');
            }

            console.log(
              `[Lead Reminder] Lead #${lead.id} sent to ${phone}`,
            );
          } catch (error) {
            errors.push(`${phone}: ${error.message}`);
          }
        }

        if (errors.length > 0) {
          throw new Error(errors.join('; ').slice(0, 950));
        }

        await pool.query(
          `UPDATE leads
           SET reminder_status = 'sent',
               reminder_sent_for = ?,
               reminder_sent_at = NOW(),
               reminder_error = NULL
           WHERE id = ?
             AND reminder_status = 'sending'`,
          [lead.next_followup, lead.id],
        );

        console.log(
          `[Lead Reminder] Lead #${lead.id} sent successfully`,
        );
      } catch (error) {
        console.error(
          `[Lead Reminder] Lead #${lead.id} failed:`,
          error.message,
        );

        await pool.query(
          `UPDATE leads
           SET reminder_status = 'failed',
               reminder_error = ?
           WHERE id = ?
             AND reminder_status = 'sending'`,
          [String(error.message).slice(0, 1000), lead.id],
        );
      }
    }
  } catch (error) {
    console.error(
      '[Lead Reminder] Database error:',
      error.message,
    );
  } finally {
    leadSchedulerBusy = false;
  }
}
function startReminderScheduler() {
  if (schedulerStarted) return;

  schedulerStarted = true;

  console.log("[Reminder Scheduler] Invoice and Lead reminders started.");
console.log("[Package Expiry Scheduler] Started.");

  processDueReminders();
  processDueLeadReminders();
processPackageExpiryReminders();

  setInterval(() => {
    processDueReminders();
    processDueLeadReminders();
  processPackageExpiryReminders();
  }, 10000);
}


let packageExpirySchedulerBusy = false;

async function processPackageExpiryReminders() {
  if (packageExpirySchedulerBusy) return;

  packageExpirySchedulerBusy = true;

  try {
    // 1. Fetch packages expiring today or in 20 days.
    // Keep the expiry date as a MySQL-formatted string to avoid timezone shifts.
    const [packages] = await pool.query(`
      SELECT
        id,
        organization_id,
        client_id,
        package_id,
        DATE_FORMAT(validity_end_date, '%Y-%m-%d') AS expiry_date,
        CASE
          WHEN DATE(validity_end_date) = CURDATE()
            THEN 'expiry_day'
          ELSE 'before_20_days'
        END AS reminder_stage
      FROM employee_package_purchase
      WHERE payment_status = 'Paid'
        AND approval_status = 'Approved'
        AND validity_end_date IS NOT NULL
        AND DATE(validity_end_date) IN (
          CURDATE(),
          DATE_ADD(CURDATE(), INTERVAL 20 DAY)
        )
      ORDER BY id ASC
    `);

    console.log(
      "[Package Expiry Scheduler] Eligible packages:",
      packages.length,
    );

    for (const pkg of packages) {
      try {
        const expiryDate = pkg.expiry_date;
        const stage = pkg.reminder_stage;

        if (!expiryDate || !stage) {
          console.log(
            `[Package Expiry] Skipping package #${pkg.id}: invalid expiry date`,
          );
          continue;
        }

        console.log(
          `[Package Expiry] Processing package #${pkg.id}, ` +
            `organization #${pkg.organization_id}, stage: ${stage}, ` +
            `expiry: ${expiryDate}`,
        );

        // 2. Prepare the reminder message.
        const message =
          stage === "expiry_day"
            ? `Package Expiry Reminder\n\nYour employee package expires today (${expiryDate}). Please renew your package to continue using the employee limit.`
            : `Package Expiry Reminder\n\nYour employee package will expire on ${expiryDate}, which is 20 days from today. Please plan your renewal.`;

        // 3. Get active Admin users for this organization.
        const [admins] = await pool.query(
          `SELECT id, customer_id
           FROM users
           WHERE organization_id = ?
             AND role = 'admin'
             AND status = 1`,
          [pkg.organization_id],
        );

        // 4. Get active Super Admin users.
        const [superAdmins] = await pool.query(
          `SELECT id
           FROM users
           WHERE role = 'super_admin'
             AND status = 1`,
        );

        console.log(
          `[Package Expiry] Package #${pkg.id}: ` +
            `admins=${admins.length}, superAdmins=${superAdmins.length}`,
        );

        // 5. Send dashboard notifications to Admin and Super Admin.
        const recipients = [
          ...admins.map((user) => ({
            type: "admin",
            id: user.id,
          })),
          ...superAdmins.map((user) => ({
            type: "super_admin",
            id: user.id,
          })),
        ];

        for (const recipient of recipients) {
          try {
            const [existing] = await pool.query(
              `SELECT id
               FROM employee_package_expiry_reminders
               WHERE package_purchase_id = ?
                 AND reminder_stage = ?
                 AND recipient_type = ?
                 AND recipient_id = ?
                 AND channel = 'dashboard'
               LIMIT 1`,
              [pkg.id, stage, recipient.type, recipient.id],
            );

            // Do not create the same dashboard reminder twice.
            if (existing.length > 0) continue;

            await pool.query(
              `INSERT INTO notifications
               (user_type, user_id, organization_id, title, message,
                notification_type, action_url, is_read)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
              [
                recipient.type,
                recipient.id,
                pkg.organization_id,
                "Package Expiry Reminder",
                message,
                "package_expiry",
                "buy-package",
              ],
            );

            await pool.query(
              `INSERT INTO employee_package_expiry_reminders
               (package_purchase_id, organization_id, recipient_type,
                recipient_id, channel, reminder_stage, status, sent_at)
               VALUES (?, ?, ?, ?, 'dashboard', ?, 'sent', NOW())`,
              [
                pkg.id,
                pkg.organization_id,
                recipient.type,
                recipient.id,
                stage,
              ],
            );

            console.log(
              `[Package Expiry] Dashboard notification created for ` +
                `${recipient.type} #${recipient.id}`,
            );
          } catch (error) {
            console.error(
              `[Package Expiry] Dashboard notification failed for ` +
                `${recipient.type} #${recipient.id}:`,
              error.message,
            );
          }
        }

        // 6. WhatsApp reminders go only to Admins.
        for (const admin of admins) {
          try {
            // Find the Admin's registered organization contact.
            const [phones] = await pool.query(
              `SELECT contact
               FROM client_services
               WHERE client_id = ?
                 AND organization_id = ?
                 AND contact IS NOT NULL
                 AND TRIM(contact) <> ''
               LIMIT 1`,
              [admin.customer_id, pkg.organization_id],
            );

            if (!phones.length) {
              console.log(
                `[Package Expiry] No contact found for Admin #${admin.id}`,
              );
              continue;
            }

            const phone = String(phones[0].contact).replace(/\D/g, "");

            if (phone.length < 10) {
              console.log(
                `[Package Expiry] Invalid phone for Admin #${admin.id}`,
              );
              continue;
            }

            // Check whether this reminder was already sent or is in progress.
            const [existing] = await pool.query(
              `SELECT id, status
               FROM employee_package_expiry_reminders
               WHERE package_purchase_id = ?
                 AND reminder_stage = ?
                 AND recipient_type = 'admin'
                 AND recipient_id = ?
                 AND channel = 'whatsapp'
               LIMIT 1`,
              [pkg.id, stage, admin.id],
            );

            if (
              existing.length &&
              ["sent", "sending"].includes(existing[0].status)
            ) {
              console.log(
                `[Package Expiry] WhatsApp already ${existing[0].status} ` +
                  `for Admin #${admin.id}; skipping`,
              );
              continue;
            }

            // Find a connected WhatsApp device for this organization.
            const [devices] = await pool.query(
              `SELECT id
               FROM whatsapp_devices
               WHERE organization_id = ?
               ORDER BY id ASC`,
              [pkg.organization_id],
            );

            let connectedDeviceId = null;

            for (const device of devices) {
              const status = getWhatsAppStatus(
                String(pkg.organization_id),
                String(device.id),
              );

              if (status.status === "connected") {
                connectedDeviceId = String(device.id);
                break;
              }
            }

            if (!connectedDeviceId) {
              throw new Error(
                `No connected WhatsApp device for organization #${pkg.organization_id}`,
              );
            }

            // Create a sending record, or reuse a previous failed record.
            if (existing.length) {
              await pool.query(
                `UPDATE employee_package_expiry_reminders
                 SET status = 'sending', last_error = NULL
                 WHERE id = ? AND status = 'failed'`,
                [existing[0].id],
              );
            } else {
              await pool.query(
                `INSERT INTO employee_package_expiry_reminders
                 (package_purchase_id, organization_id, recipient_type,
                  recipient_id, channel, reminder_stage, status)
                 VALUES (?, ?, 'admin', ?, 'whatsapp', ?, 'sending')`,
                [pkg.id, pkg.organization_id, admin.id, stage],
              );
            }

            // 7. Send the WhatsApp message.
            const result = await sendWhatsAppMessage(
              String(pkg.organization_id),
              connectedDeviceId,
              phone,
              message,
            );

            if (!result || result.success !== true) {
              throw new Error("WhatsApp send was not confirmed");
            }

            // 8. Mark the reminder as sent.
            await pool.query(
              `UPDATE employee_package_expiry_reminders
               SET status = 'sent',
                   sent_at = NOW(),
                   last_error = NULL
               WHERE package_purchase_id = ?
                 AND reminder_stage = ?
                 AND recipient_type = 'admin'
                 AND recipient_id = ?
                 AND channel = 'whatsapp'`,
              [pkg.id, stage, admin.id],
            );

            console.log(
              `[Package Expiry] WhatsApp sent successfully to Admin #${admin.id}`,
            );
          } catch (error) {
            console.error(
              `[Package Expiry] WhatsApp failed for Admin #${admin.id}:`,
              error.message,
            );

            // Update an existing reminder record to failed.
            try {
              await pool.query(
                `UPDATE employee_package_expiry_reminders
                 SET status = 'failed', last_error = ?
                 WHERE package_purchase_id = ?
                   AND reminder_stage = ?
                   AND recipient_type = 'admin'
                   AND recipient_id = ?
                   AND channel = 'whatsapp'
                   AND status = 'sending'`,
                [String(error.message).slice(0, 2000), pkg.id, stage, admin.id],
              );
            } catch (updateError) {
              console.error(
                "[Package Expiry] Could not update failure status:",
                updateError.message,
              );
            }
          }
        }
      } catch (error) {
        console.error(
          `[Package Expiry] Package #${pkg.id} failed:`,
          error.message,
        );
      }
    }
  } catch (error) {
    console.error("[Package Expiry Scheduler] Error:", error.message);
  } finally {
    packageExpirySchedulerBusy = false;
  }
}


module.exports = {
  startReminderScheduler,
  processDueReminders,
  processDueLeadReminders,
  processPackageExpiryReminders,
};
