import "dotenv/config";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { setServers } from "node:dns";
import { User } from "./models.js";

const accounts = [
  { role: "admin", name: process.env.ADMIN_NAME, email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD },
  { role: "staff", name: process.env.STAFF_NAME, email: process.env.STAFF_EMAIL, password: process.env.STAFF_PASSWORD },
];
const selectedAccounts = process.argv[2] === "admin" ? accounts.slice(0, 1) : accounts;
for (const account of selectedAccounts) {
  if (!account.name?.trim() || !account.email?.trim() || !account.password || account.password.length < 12) {
    throw new Error(`Set ${account.role.toUpperCase()}_NAME, ${account.role.toUpperCase()}_EMAIL, and ${account.role.toUpperCase()}_PASSWORD (at least 12 characters).`);
  }
}
if (!process.env.MONGODB_URI) throw new Error("Set MONGODB_URI.");

const mongoDnsServers = process.env.MONGODB_DNS_SERVERS?.split(",").map((server) => server.trim()).filter(Boolean);
if (mongoDnsServers?.length) setServers(mongoDnsServers);

await mongoose.connect(process.env.MONGODB_URI);
try {
  for (const account of selectedAccounts) {
    const email = account.email.trim().toLowerCase();
    const username = email.split("@")[0];
    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) {
      if (existing.role !== account.role || existing.email !== email) {
        throw new Error(`The configured ${account.role} email or username is already used by a different account.`);
      }
      console.log(`${account.role} account already exists; no changes made.`);
      continue;
    }
    const passwordHash = await bcrypt.hash(account.password, 12);
    await User.create({ name: account.name.trim(), email, username, passwordHash, role: account.role, isActive: true });
    console.log(`Created ${account.role} account for ${email}.`);
  }
} finally {
  await mongoose.disconnect();
}
