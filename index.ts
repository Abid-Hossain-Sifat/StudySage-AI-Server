import express, { type Request, type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion } from "mongodb";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./auth.js";

dotenv.config();

const app = express();

app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.all("/api/auth/{*any}", toNodeHandler(auth));
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI!, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const run = async () => {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("MongoDB connected successfully");
  } catch (error) {
    console.log(error);
    await client.close();
  }
};

run();

app.get("/", (_req: Request, res: Response) => {
  res.send("StudySage AI Server is Online");
});
app.listen(process.env.PORT, () => {
  console.log(`Server running on Port ${process.env.PORT}`);
});
