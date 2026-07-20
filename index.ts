import express, { type Request, type Response } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.js";

dotenv.config();

const app = express();

// ─── Middleware ───────────────────────────────────────────────
app.use(cors({ origin: process.env.CLIENT_URL, credentials: true }));
app.all("/api/auth/{*any}", toNodeHandler(auth));
app.use(express.json());

// ─── MongoDB Connection ───────────────────────────────────────
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

    // ─── Collections ─────────────────────────────────────────
    const db = client.db("StudySage");
    const notesCollection = db.collection("Notes");

    // ─── Session Helper ───────────────────────────────────────
    const getSession = (req: Request) =>
      auth.api.getSession({ headers: fromNodeHeaders(req.headers) });

    // ─── POST /notes ──────────────────────────────────────────
    app.post("/notes", async (req: Request, res: Response) => {
      const session = await getSession(req);
      if (!session) return void res.status(401).json({ error: "Unauthorized" });

      const {
        title,
        content,
        shortDescription,
        thumbnail,
        subject,
        difficulty,
        keywords,
        summary,
        practiceQuestions,
        source,
        visibility = "public",
      } = req.body;

      if (!title || !content)
        return void res
          .status(400)
          .json({ error: "Title and content required" });

      const note = {
        title,
        content,
        shortDescription,
        thumbnail,
        subject,
        difficulty,
        keywords,
        summary,
        practiceQuestions,
        source,
        visibility,
        userId: session.user.id,
        userName: session.user.name,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await notesCollection.insertOne(note);
      res.status(201).json({ ...note, _id: result.insertedId });
    });

    // ─── GET /notes/subjects ──────────────────────────────────
    app.get("/notes/subjects", async (_req: Request, res: Response) => {
      const subjects = await notesCollection.distinct("subject", {
        visibility: "public",
      });
      res.json({ subjects: subjects.filter(Boolean) });
    });

    // ─── GET /notes ───────────────────────────────────────────
    app.get("/notes", async (req: Request, res: Response) => {
      const {
        search,
        subject,
        difficulty,
        sort,
        page = "1",
        limit = "8",
      } = req.query as Record<string, string>;

      const filter: Record<string, unknown> = { visibility: "public" };

      if (search) {
        filter.$or = [
          { title: { $regex: search, $options: "i" } },
          { shortDescription: { $regex: search, $options: "i" } },
          { subject: { $regex: search, $options: "i" } },
        ];
      }

      if (subject && subject !== "All") filter.subject = subject;
      if (difficulty && difficulty !== "All") filter.difficulty = difficulty;

      const sortOrder: Record<string, 1 | -1> =
        sort === "oldest"
          ? { createdAt: 1 }
          : sort === "az"
            ? { title: 1 }
            : { createdAt: -1 };

      const skip = (Number(page) - 1) * Number(limit);

      const [notes, total] = await Promise.all([
        notesCollection
          .find(filter)
          .sort(sortOrder)
          .skip(skip)
          .limit(Number(limit))
          .toArray(),
        notesCollection.countDocuments(filter),
      ]);

      res.json({ notes, total });
    });

    // ─── GET /my-notes ────────────────────────────────────────
    app.get("/my-notes", async (req: Request, res: Response) => {
      const session = await getSession(req);
      if (!session) return void res.status(401).json({ error: "Unauthorized" });

      const notes = await notesCollection
        .find({ userId: session.user.id })
        .sort({ createdAt: -1 })
        .toArray();
      res.json(notes);
    });

    // ─── GET /notes/:id ───────────────────────────────────────
    app.get(
      "/notes/:id",
      async (req: Request<{ id: string }>, res: Response) => {
        const note = await notesCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!note)
          return void res.status(404).json({ error: "Note not found" });
        res.json(note);
      },
    );

    // ─── PATCH /notes/:id ────────────────────────────────────
    app.patch(
      "/notes/:id",
      async (req: Request<{ id: string }>, res: Response) => {
        const session = await getSession(req);
        if (!session)
          return void res.status(401).json({ error: "Unauthorized" });

        const { title, content } = req.body;
        const result = await notesCollection.findOneAndUpdate(
          { _id: new ObjectId(req.params.id), userId: session.user.id },
          { $set: { title, content, updatedAt: new Date() } },
          { returnDocument: "after" },
        );

        if (!result)
          return void res.status(404).json({ error: "Note not found" });
        res.json(result);
      },
    );

    // ─── PATCH /notes/:id/visibility ─────────────────────────
    app.patch(
      "/notes/:id/visibility",
      async (req: Request<{ id: string }>, res: Response) => {
        const session = await getSession(req);
        if (!session)
          return void res.status(401).json({ error: "Unauthorized" });

        const { visibility } = req.body;
        if (!["public", "private"].includes(visibility))
          return void res
            .status(400)
            .json({ error: "visibility must be public or private" });

        const result = await notesCollection.findOneAndUpdate(
          { _id: new ObjectId(req.params.id), userId: session.user.id },
          { $set: { visibility, updatedAt: new Date() } },
          { returnDocument: "after" },
        );

        if (!result)
          return void res.status(404).json({ error: "Note not found" });
        res.json(result);
      },
    );

    // ─── DELETE /notes/:id ───────────────────────────────────
    app.delete(
      "/notes/:id",
      async (req: Request<{ id: string }>, res: Response) => {
        const session = await getSession(req);
        if (!session)
          return void res.status(401).json({ error: "Unauthorized" });

        const result = await notesCollection.deleteOne({
          _id: new ObjectId(req.params.id),
          userId: session.user.id,
        });

        if (result.deletedCount === 0)
          return void res.status(404).json({ error: "Note not found" });
        res.json({ success: true });
      },
    );
  } catch (error) {
    console.log(error);
    await client.close();
  }
};

run();

// ─── Health Check ─────────────────────────────────────────────
app.get("/", (_req: Request, res: Response) => {
  res.send("StudySage AI Server is Online");
});

// ─── Server Start ─────────────────────────────────────────────
app.listen(process.env.PORT, () => {
  console.log(`Server running on Port ${process.env.PORT}`);
});
