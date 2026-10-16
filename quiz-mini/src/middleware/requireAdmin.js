module.exports = function requireAdmin(req, res, next) {
  if (!req.session || req.session.role !== 'admin') {
    return res.status(401).json({ message: 'Vui lòng đăng nhập bằng tài khoản admin.' });
  }
  next();
};
