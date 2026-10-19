// config.js - Cấu hình kết nối Backend
// Tự động nhận diện: Khi chạy ở máy tính (localhost/127.0.0.1) dùng Backend local (''), khi deploy dùng Render
window.API_BASE_URL = (typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'))
  ? ''
  : 'https://quiz-mini-project-d59p.onrender.com';
