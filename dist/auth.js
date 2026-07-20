"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.auth = void 0;
const better_auth_1 = require("better-auth");
const mongodb_1 = require("better-auth/adapters/mongodb");
const mongodb_2 = require("mongodb");
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
const client = new mongodb_2.MongoClient(process.env.MONGODB_URI, {
    serverApi: {
        version: mongodb_2.ServerApiVersion.v1,
        strict: false,
        deprecationErrors: true,
    },
});
exports.auth = (0, better_auth_1.betterAuth)({
    database: (0, mongodb_1.mongodbAdapter)(client.db("StudySage")),
    trustedOrigins: [process.env.CLIENT_URL],
    emailAndPassword: { enabled: true },
    socialProviders: {
        google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        },
    },
});
