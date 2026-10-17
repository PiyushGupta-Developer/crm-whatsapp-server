const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "updated_crm",
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  timezone: "+05:30",
});


async function testDatabaseConnection() {
  const connection = await pool.getConnection();

  try {
    const [rows] = await connection.query(`
      SELECT
        DATABASE() AS database_name,
        CURDATE() AS database_today,
        NOW() AS database_now
    `);

    console.log("[MySQL] Connection verified:", rows[0]);

    const [packages] = await connection.query(`
      SELECT
        id,
        validity_end_date,
        payment_status,
        approval_status
      FROM employee_package_purchase
      WHERE id = 10
    `);

    console.log("[MySQL] Package #10:", packages);
  } finally {
    connection.release();
  }
}


module.exports = { pool, testDatabaseConnection };
