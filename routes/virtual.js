const express = require("express");

module.exports = () => {
  const router = express.Router();
  router.use((req, res) => {
    res.status(403).json({ message: "Virtual trading is unavailable" });
  });
  return router;
};
