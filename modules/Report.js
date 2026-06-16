const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const reportSchema = new Schema(
  {
    reporterEmail: { type: String, required: true },
    reportedEmail: { type: String, required: true },
    reason: { type: String, required: true },
    chatId: { type: String },
    status: { type: String, enum: ["open", "pending", "reviewing", "reviewed", "resolved", "closed"], default: "open" },
    adminNotes: { type: String, default: "" },
    actionTaken: { type: String, default: "" },
    handledBy: { type: String, default: "" },
    handledAt: { type: Date, default: null },
  },
  { timestamps: true }
);

reportSchema.index({ status: 1, createdAt: -1 });
reportSchema.index({ reportedEmail: 1, createdAt: -1 });

const Report = mongoose.model("Report", reportSchema);
module.exports = Report;
