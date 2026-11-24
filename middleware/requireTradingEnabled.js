function requireTradingEnabled(req, res, next) {
  if (process.env.TRADING_ENABLED !== "true") {
    return res.status(403).json({
      message: "Trading is disabled. Manage existing orders and positions directly with your broker.",
    });
  }

  next();
}

module.exports = requireTradingEnabled;
