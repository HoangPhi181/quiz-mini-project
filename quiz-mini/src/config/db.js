const mysql = require('mysql2/promise');

const isSsl = process.env.DB_SSL === 'true' || process.env.NODE_ENV === 'production';

const pool = process.env.DB_URI
  ? mysql.createPool(process.env.DB_URI)
  : mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'quiz_mini',
      ssl: isSsl ? { rejectUnauthorized: false } : undefined,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4'
    });

module.exports = pool;
