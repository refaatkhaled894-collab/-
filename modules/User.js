const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const Schema = mongoose.Schema;

const userSchema = new Schema(
  {
    username1: { type: String, required: true, trim: true },
    username2: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, required: true, minlength: 8 },
    learnSkills: { type: [String], default: [] },
    teachSkills: { type: [String], default: [] },
    verifiedSkills: { type: [String], default: [] },
    avatar: { type: String, default: "" }, 
    skillTestResults: {
      type: Map,
      of: {
        pct: Number,
        passed: Boolean,
        date: String,
      },
      default: {},
    },
    bio: { type: String, default: "مطور ويب شغوف بالتعلم ومشاركة المعرفة. أحب العمل على المشاريع التقنية وأسعى دائماً لتطوير مهاراتي." },
    deletedConnections: { type: [String], default: [] },
    reviews: [
      {
        reviewerEmail: String,
        reviewerName: String,
        rating: Number,
        comment: String,
        date: { type: Date, default: Date.now }
      }
    ],
    // 🛡 Admin Roles and Status
    role: { type: String, enum: ["user", "admin"], default: "user" },
    status: { type: String, enum: ["active", "banned"], default: "active" },

    // 🎖 Gamification System
    gamifyPoints: { type: Number, default: 0 },
    gamifyLevel: { type: String, default: "عضو جديد" },

    // 🔔 Notifications System
    notifications: [
      {
        title: String,
        message: String,
        type: { type: String, default: "info" }, // 'info', 'warning', 'success'
        read: { type: Boolean, default: false },
        date: { type: Date, default: Date.now }
      }
    ]
  },
  { timestamps: true }
);

// Hash password before saving
userSchema.pre("save", async function () {
  if (!this.isModified("password")) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Return safe user object (no password)
userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  return obj;
};

// Indexes لتسريع خوارزمية المطابقة
userSchema.index({ verifiedSkills: 1 });
userSchema.index({ learnSkills: 1 });
userSchema.index({ teachSkills: 1 });
userSchema.index({ status: 1 });
userSchema.index({ createdAt: -1 });

const User = mongoose.model("User", userSchema);
module.exports = User;
