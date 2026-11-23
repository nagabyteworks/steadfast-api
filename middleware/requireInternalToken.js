const { timingSafeEqual } = require("node:crypto");

module.exports = (token) => (req, res, next) => {
  if (!token) return next();

  const provided = req.headers["x-steadfast-internal-token"];
  if (typeof provided !== "string") {
    return res.status(403).json({ message: "Internal access denied" });
  }
  const expectedBuffer = Buffer.from(token);
  const providedBuffer = Buffer.from(provided);
  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    return res.status(403).json({ message: "Internal access denied" });
  }
  next();
};
