import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { MongoClient, ServerApiVersion } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const mongoUri = process.env.MONGODB_URI || "mongodb://localhost:27017/StudySage";
const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";

export const client = new MongoClient(mongoUri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: false,
    deprecationErrors: true,
  },
});

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET || "studysage_fallback_secret_key_987654321",
  database: mongodbAdapter(client.db("StudySage")),
  trustedOrigins: [clientUrl],
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID || "placeholder",
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || "placeholder",
    },
  },
  plugins: [jwt()],
});