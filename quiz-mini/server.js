require('dotenv').config();
const http = require('http');
const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const quizRoutes = require('./src/routes/quizRoutes');
const authRoutes = require('./src/routes/authRoutes');
const { initWebSocketServer } = require('./src/services/websocketService');

const app = express();

const isProd = process.env.NODE_ENV === 'production';

// Tin tưởng reverse proxy của Render để session cookie (secure) hoạt động chính xác
app.set('trust proxy', 1);

// Cấu hình CORS: cho phép Frontend URL từ biến môi trường hoặc tự động theo origin
const allowedOrigins = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL.replace(/\/$/, ''), 'http://localhost:3000']
  : true;

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(express.json({ limit: '1mb' }));
app.use(session({
  name: 'quiz.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    // Cross-site (Vercel -> Render) trên HTTPS bắt buộc SameSite=None và Secure=true
    sameSite: isProd ? 'none' : 'lax',
    secure: isProd,
    maxAge: 8 * 60 * 60 * 1000
  }
}));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api/auth', authRoutes);
app.use('/api', quizRoutes);
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ message: 'Lỗi máy chủ. Vui lòng thử lại.' });
});

const server = http.createServer(app);
initWebSocketServer(server);

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`Quiz Mini running at http://localhost:${port}`));
