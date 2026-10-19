const mysql = require('mysql2/promise');

const isSsl = process.env.DB_SSL === 'true' || process.env.NODE_ENV === 'production';

// Cấu hình tối ưu cho Aiven MySQL Free Tier (giới hạn connection, tránh quá tải khi 100 người dùng đồng thời)
const poolConfig = {
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 12),
  maxIdle: 10,
  idleTimeout: 30000,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  charset: 'utf8mb4'
};

let pool;
if (process.env.DB_URI) {
  pool = mysql.createPool({
    uri: process.env.DB_URI,
    ssl: { rejectUnauthorized: false },
    ...poolConfig
  });
} else {
  pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'quiz_mini',
    ssl: isSsl ? { rejectUnauthorized: false } : undefined,
    ...poolConfig
  });
}

// Tự động kiểm tra và thêm các composite index và cột cần thiết trên MySQL
(async function initDatabaseIndexes() {
  try {
    // Tự động kiểm tra và thêm cột sort_order cho bảng quizzes nếu chưa có
    const [colRows] = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'quizzes' AND column_name = 'sort_order'"
    );
    if (!colRows || colRows.length === 0) {
      await pool.query("ALTER TABLE quizzes ADD COLUMN sort_order INT NOT NULL DEFAULT 0");
      console.log('[DB] Đã thêm cột sort_order vào bảng quizzes');
    }

    const indexes = [
      { table: 'quizzes', name: 'idx_quizzes_sort', cols: '(sort_order ASC, id DESC)' },
      { table: 'participants', name: 'idx_participants_quiz_sub', cols: '(quiz_id, submitted_at)' },
      { table: 'participants', name: 'idx_participants_quiz_score', cols: '(quiz_id, score DESC, submitted_at ASC)' },
      { table: 'answers', name: 'idx_answers_q_correct', cols: '(question_id, is_correct)' }
    ];
    for (const idx of indexes) {
      const [rows] = await pool.query(
        'SELECT 1 FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
        [idx.table, idx.name]
      );
      if (!rows || rows.length === 0) {
        await pool.query(`ALTER TABLE ${idx.table} ADD INDEX ${idx.name} ${idx.cols}`);
        console.log(`[DB] Đã kích hoạt index tối ưu: ${idx.name} trên bảng ${idx.table}`);
      }
    }
  } catch (err) {
    // Không chặn ứng dụng nếu tài khoản không có quyền ALTER hoặc đã có cấu trúc tương đương
    console.log('[DB] Migration/Index note:', err.message);
  }
})();

module.exports = pool;
