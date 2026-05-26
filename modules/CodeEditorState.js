const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const codeEditorStateSchema = new Schema(
  {
    chatId: { type: String, required: true, unique: true, index: true },
    lastActivity: { type: Date, default: Date.now },
    content: { type: String, default: "// ابدأ الكتابة...\n" },
    language: { type: String, default: "javascript" },
    revision: { type: Number, default: 0 },
  },
  { timestamps: true }
);

const ttlSeconds = Math.max(
  86400,
  Number(process.env.CODE_EDITOR_TTL_SECONDS || 60 * 60 * 24 * 30) // 30 days
);
codeEditorStateSchema.index({ lastActivity: 1 }, { expireAfterSeconds: ttlSeconds });

const CodeEditorState = mongoose.model("CodeEditorState", codeEditorStateSchema);
module.exports = CodeEditorState;
