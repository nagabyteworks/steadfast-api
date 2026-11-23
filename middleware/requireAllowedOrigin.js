module.exports = (allowedOrigin) => (req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    return next();
  }
  if (req.headers.origin !== allowedOrigin) {
    return res.status(403).json({ message: "Request origin is not allowed" });
  }
  next();
};
