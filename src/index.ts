import "dotenv/config";
import express from "express";
import cors from "cors";
import aiRoutes from "./routes/ai";
import smartRoutes from "./routes/smart";
import checkinRoutes from "./routes/checkin";
import alertRoutes from "./routes/alerts";
import { authMiddleware } from "./middleware/auth";
import { startJobs } from "./jobs/scheduler";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Health check
app.get("/health", (_req, res) => res.json({ status: "ok", service: "shepherdhub-api" }));

// Public check-in (no auth)
app.use("/api/checkin", checkinRoutes);

// Protected AI routes
app.use("/api/ai", authMiddleware, aiRoutes);
app.use("/api/smart", authMiddleware, smartRoutes);
app.use("/api/alerts", authMiddleware, alertRoutes);

// Start cron jobs
startJobs();

app.listen(PORT, () => {
  console.log(`ShepherdHub API running on port ${PORT}`);
});
