import mongoose from "mongoose";
import { randomUUID } from "node:crypto";

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  email: { type: String, required: true, lowercase: true, trim: true },
  username: { type: String, required: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ["admin", "staff"], required: true },
  isActive: { type: Boolean, default: true },
  mustChangePassword: { type: Boolean, default: false },
}, { timestamps: { createdAt: true, updatedAt: false } });
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ username: 1 }, { unique: true });

const ticketSchema = new mongoose.Schema({
  _id: { type: String, default: randomUUID },
  studentId: { type: String, required: true, trim: true, uppercase: true },
  queueNumber: { type: String, required: true },
  queueSequence: { type: Number, required: true },
  queueDate: { type: String, required: true },
  status: { type: String, enum: ["waiting", "serving", "completed", "no-show"], default: "waiting", required: true },
  joinedAt: { type: Date, default: Date.now, required: true },
  calledAt: Date,
  completedAt: Date,
  noShowAt: Date,
  callExpiresAt: Date,
}, { versionKey: false });
ticketSchema.index({ queueDate: 1, queueNumber: 1 }, { unique: true });
ticketSchema.index({ studentId: 1, queueDate: 1 }, {
  unique: true,
  partialFilterExpression: { $or: [{ status: "waiting" }, { status: "serving" }] },
});
ticketSchema.index({ status: 1 }, {
  unique: true,
  partialFilterExpression: { status: "serving" },
});
ticketSchema.index({ queueDate: 1, status: 1, joinedAt: 1 });

const settingsSchema = new mongoose.Schema({
  _id: { type: String, default: "global" },
  noShowDuration: { type: Number, default: 180, min: 30, max: 3600 },
  dailyQueueReset: { type: Boolean, default: true },
  systemStatus: { type: String, enum: ["active", "paused"], default: "active" },
  updatedAt: { type: Date, default: Date.now },
});

const historySchema = new mongoose.Schema({
  ticketId: { type: String, required: true, index: true },
  studentId: { type: String, required: true },
  queueNumber: { type: String, required: true },
  queueDate: { type: String, required: true, index: true },
  action: { type: String, required: true },
  performedBy: { type: String, default: "System" },
  timestamp: { type: Date, default: Date.now, index: true },
});
historySchema.index({ timestamp: -1 });

const counterSchema = new mongoose.Schema({
  _id: String,
  sequence: { type: Number, default: 0 },
}, { versionKey: false });

export const User = mongoose.models.User || mongoose.model("User", userSchema);
export const QueueTicket = mongoose.models.QueueTicket || mongoose.model("QueueTicket", ticketSchema);
export const QueueSettings = mongoose.models.QueueSettings || mongoose.model("QueueSettings", settingsSchema);
export const QueueHistory = mongoose.models.QueueHistory || mongoose.model("QueueHistory", historySchema);
export const QueueCounter = mongoose.models.QueueCounter || mongoose.model("QueueCounter", counterSchema);
