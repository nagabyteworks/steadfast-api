function requireTradingEnabled(req, res, next) {
  if (process.env.NODE_ENV === "production") {
    return res.status(403).json({
      message: "Production trading is unavailable until protective order management is implemented and verified.",
    });
  }
  if (process.env.TRADING_ENABLED !== "true") {
    return res.status(403).json({
      message: "Trading is disabled. Manage existing orders and positions directly with your broker.",
    });
  }

  next();
}

module.exports = requireTradingEnabled;
