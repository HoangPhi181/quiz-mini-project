const router = require('express').Router();
const requireAdmin = require('../middleware/requireAdmin');

router.post('/admin-login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === (process.env.ADMIN_USERNAME || 'admin') && password === (process.env.ADMIN_PASSWORD || 'BrainZone123!')) {
    req.session.role = 'admin';
    req.session.username = username;
    return res.json({ message: 'Đăng nhập thành công.' });
  }
  return res.status(401).json({ message: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
});
router.get('/me', (req, res) => res.json({ role: req.session?.role || 'guest', username: req.session?.username || null }));
router.post('/logout', requireAdmin, (req, res) => req.session.destroy(() => res.json({ message: 'Đã đăng xuất.' })));
module.exports = router;
