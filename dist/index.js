import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { ObjectId } from "mongodb";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";
import { auth, client } from "./auth.js";
// @ts-ignore
import multer from "multer";
dotenv.config();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });
async function extractPdfText(buffer) {
    // @ts-ignore
    const pdfParseMod = await import("pdf-parse/lib/pdf-parse.js");
    const parseFn = typeof pdfParseMod.default === "function" ? pdfParseMod.default : pdfParseMod;
    if (typeof parseFn === "function") {
        const res = await parseFn(buffer);
        return res.text ?? "";
    }
    throw new Error("Could not initialize PDF parser");
}
const app = express();
// ─── Middleware ───────────────────────────────────────────────
const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";
app.use(cors({ origin: clientUrl, credentials: true }));
let isConnected = false;
async function ensureDbConnected() {
    if (!process.env.MONGODB_URI) {
        throw new Error("MONGODB_URI is missing in Vercel Environment Variables.");
    }
    if (!isConnected) {
        await client.connect();
        isConnected = true;
    }
}
async function getNotesCollection() {
    await ensureDbConnected();
    return client.db("StudySage").collection("Notes");
}
// ─── Better Auth Route Wrapper ────────────────────────────────
app.use("/api/auth", async (req, res, next) => {
    try {
        if (!process.env.MONGODB_URI) {
            return void res.status(500).json({
                error: "MONGODB_URI is not set in Vercel Environment Variables. Please set MONGODB_URI in Vercel Dashboard Settings -> Environment Variables and redeploy."
            });
        }
        await ensureDbConnected();
        const handler = toNodeHandler(auth);
        return handler(req, res);
    }
    catch (err) {
        console.error("Auth Route Error:", err);
        res.status(500).json({ error: err.message || "Authentication service error" });
    }
});
app.use(express.json());
// ─── Session Helper ───────────────────────────────────────────
const getSession = async (req) => {
    try {
        if (!process.env.MONGODB_URI)
            return null;
        await ensureDbConnected();
        return await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    }
    catch (err) {
        console.error("getSession error:", err);
        return null;
    }
};
// ─── Health Check & Favicon ───────────────────────────────────
app.get("/", (_req, res) => {
    res.send("StudySage AI Server is Online");
});
app.get("/favicon.ico", (_req, res) => {
    res.status(204).end();
});
// ─── POST /generate-notes ─────────────────────────────────────
app.post("/generate-notes", async (req, res) => {
    try {
        const session = await getSession(req);
        if (!session)
            return void res.status(401).json({ error: "Unauthorized" });
        const { topic, subject, keywords = [], difficulty = "Beginner", outputLength = "Medium", writingStyle = "Simple", feedback, previousNote } = req.body;
        if (!topic || !subject) {
            return void res.status(400).json({ error: "Topic and subject are required" });
        }
        const notesCollection = await getNotesCollection();
        const recentNotes = await notesCollection
            .find({ userId: session.user.id, subject })
            .sort({ createdAt: -1 })
            .limit(3)
            .toArray();
        const memory = recentNotes.map((n) => ({
            title: n.title,
            subject: n.subject,
            summary: n.summary || n.shortDescription || "",
        }));
        const { generateStudyNote } = await import("./gemini.js");
        const result = await generateStudyNote({
            topic, subject, keywords, difficulty, outputLength, writingStyle,
            memory, feedback,
            previousNote: previousNote
                ? typeof previousNote === "string"
                    ? previousNote
                    : JSON.stringify(previousNote, null, 2)
                : undefined,
        });
        const noteDoc = {
            title: result.title,
            content: result.content,
            shortDescription: result.summary,
            subject, difficulty, keywords,
            summary: result.summary,
            keyTakeaways: result.keyTakeaways,
            practiceQuestions: result.practiceQuestions,
            source: "seed",
            visibility: "private",
            userId: session.user.id,
            userName: session.user.name,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const insertResult = await notesCollection.insertOne(noteDoc);
        res.json({ ...result, _id: insertResult.insertedId, visibility: "private" });
    }
    catch (error) {
        console.error("Error generating notes:", error);
        res.status(500).json({ error: error.message || "Failed to generate note" });
    }
});
// ─── POST /analyze-notes ──────────────────────────────────────
app.post("/analyze-notes", upload.single("file"), async (req, res) => {
    try {
        const session = await getSession(req);
        if (!session)
            return void res.status(401).json({ error: "Unauthorized" });
        const request = req;
        if (!request.file) {
            return void res.status(400).json({ error: "No file uploaded" });
        }
        let extractedText = "";
        const fileName = request.file.originalname.toLowerCase();
        if (fileName.endsWith(".pdf")) {
            extractedText = await extractPdfText(request.file.buffer);
        }
        else if (fileName.endsWith(".docx")) {
            const mammoth = await import("mammoth");
            const parsed = await mammoth.extractRawText({ buffer: request.file.buffer });
            extractedText = parsed.value;
        }
        else if (fileName.endsWith(".txt")) {
            extractedText = request.file.buffer.toString("utf-8");
        }
        else {
            return void res.status(400).json({ error: "Unsupported file type. Use PDF, DOCX, or TXT." });
        }
        if (!extractedText.trim()) {
            return void res.status(400).json({ error: "The uploaded file has no readable text content." });
        }
        const { analyzeDocumentText } = await import("./gemini.js");
        const result = await analyzeDocumentText(extractedText);
        const keyPoints = Array.isArray(result.keyPoints) ? result.keyPoints : [];
        const importantTerms = Array.isArray(result.importantTerms) ? result.importantTerms : [];
        const actionItems = Array.isArray(result.actionItems) ? result.actionItems : [];
        const practiceQuestions = Array.isArray(result.practiceQuestions) ? result.practiceQuestions : [];
        const contentMarkdown = `
# Summary
${result.summary ?? ""}

## Key Points
${keyPoints.map((kp) => `- ${kp}`).join("\n")}

## Important Terms
${importantTerms.map((t) => `- **${t.term}**: ${t.definition}`).join("\n")}

## Action Items
${actionItems.map((item) => `- [ ] ${item}`).join("\n")}
    `.trim();
        const noteDoc = {
            title: `Analysis of ${request.file.originalname}`,
            content: contentMarkdown,
            shortDescription: (result.summary ?? "").slice(0, 200),
            subject: "Document Analysis",
            difficulty: "Intermediate",
            keywords: ["analysis", "document"],
            summary: result.summary,
            practiceQuestions: practiceQuestions,
            source: "summarized",
            visibility: "private",
            userId: session.user.id,
            userName: session.user.name,
            createdAt: new Date(),
            updatedAt: new Date(),
        };
        const notesCollection = await getNotesCollection();
        const insertResult = await notesCollection.insertOne(noteDoc);
        res.json({ ...result, _id: insertResult.insertedId, visibility: "private" });
    }
    catch (error) {
        console.error("Error analyzing notes:", error);
        res.status(500).json({ error: error.message || "Failed to analyze document" });
    }
});
// ─── POST /notes ──────────────────────────────────────────────
app.post("/notes", async (req, res) => {
    try {
        const session = await getSession(req);
        if (!session)
            return void res.status(401).json({ error: "Unauthorized" });
        const { title, content, shortDescription, thumbnail, subject, difficulty, keywords, summary, practiceQuestions, source, visibility = "public" } = req.body;
        if (!title || !content)
            return void res.status(400).json({ error: "Title and content required" });
        const notesCollection = await getNotesCollection();
        const note = { title, content, shortDescription, thumbnail, subject, difficulty, keywords, summary, practiceQuestions, source, visibility, userId: session.user.id, userName: session.user.name, createdAt: new Date(), updatedAt: new Date() };
        const result = await notesCollection.insertOne(note);
        res.status(201).json({ ...note, _id: result.insertedId });
    }
    catch (error) {
        res.status(500).json({ error: error.message || "Failed to create note" });
    }
});
// ─── GET /notes/subjects ──────────────────────────────────────
app.get("/notes/subjects", async (_req, res) => {
    try {
        const notesCollection = await getNotesCollection();
        const subjects = await notesCollection.distinct("subject", { visibility: "public" });
        res.json({ subjects: subjects.filter(Boolean) });
    }
    catch (error) {
        res.status(500).json({ error: error.message || "Failed to fetch subjects" });
    }
});
// ─── GET /notes ───────────────────────────────────────────────
app.get("/notes", async (req, res) => {
    try {
        const { search, subject, difficulty, sort, page = "1", limit = "8" } = req.query;
        const filter = { visibility: "public" };
        if (search) {
            filter.$or = [
                { title: { $regex: search, $options: "i" } },
                { shortDescription: { $regex: search, $options: "i" } },
                { subject: { $regex: search, $options: "i" } },
            ];
        }
        if (subject && subject !== "All")
            filter.subject = subject;
        if (difficulty && difficulty !== "All")
            filter.difficulty = difficulty;
        const sortOrder = sort === "oldest" ? { createdAt: 1 } : sort === "az" ? { title: 1 } : { createdAt: -1 };
        const skip = (Number(page) - 1) * Number(limit);
        const notesCollection = await getNotesCollection();
        const [notes, total] = await Promise.all([
            notesCollection.find(filter).sort(sortOrder).skip(skip).limit(Number(limit)).toArray(),
            notesCollection.countDocuments(filter),
        ]);
        res.json({ notes, total });
    }
    catch (error) {
        res.status(500).json({ error: error.message || "Failed to fetch notes" });
    }
});
// ─── GET /my-notes ────────────────────────────────────────────
app.get("/my-notes", async (req, res) => {
    try {
        const session = await getSession(req);
        if (!session)
            return void res.status(401).json({ error: "Unauthorized" });
        const notesCollection = await getNotesCollection();
        const notes = await notesCollection.find({ userId: session.user.id }).sort({ createdAt: -1 }).toArray();
        res.json(notes);
    }
    catch (error) {
        res.status(500).json({ error: error.message || "Failed to fetch my notes" });
    }
});
// ─── GET /notes/:id ───────────────────────────────────────────
app.get("/notes/:id", async (req, res) => {
    try {
        const notesCollection = await getNotesCollection();
        const note = await notesCollection.findOne({ _id: new ObjectId(req.params.id) });
        if (!note)
            return void res.status(404).json({ error: "Note not found" });
        res.json(note);
    }
    catch (error) {
        res.status(500).json({ error: error.message || "Failed to fetch note" });
    }
});
// ─── PATCH /notes/:id ────────────────────────────────────────
app.patch("/notes/:id", async (req, res) => {
    try {
        const session = await getSession(req);
        if (!session)
            return void res.status(401).json({ error: "Unauthorized" });
        const { title, content } = req.body;
        const notesCollection = await getNotesCollection();
        const result = await notesCollection.findOneAndUpdate({ _id: new ObjectId(req.params.id), userId: session.user.id }, { $set: { title, content, updatedAt: new Date() } }, { returnDocument: "after" });
        if (!result)
            return void res.status(404).json({ error: "Note not found" });
        res.json(result);
    }
    catch (error) {
        res.status(500).json({ error: error.message || "Failed to update note" });
    }
});
// ─── PATCH /notes/:id/visibility ─────────────────────────────
app.patch("/notes/:id/visibility", async (req, res) => {
    try {
        const session = await getSession(req);
        if (!session)
            return void res.status(401).json({ error: "Unauthorized" });
        const { visibility } = req.body;
        if (!["public", "private"].includes(visibility))
            return void res.status(400).json({ error: "visibility must be public or private" });
        const notesCollection = await getNotesCollection();
        const result = await notesCollection.findOneAndUpdate({ _id: new ObjectId(req.params.id), userId: session.user.id }, { $set: { visibility, updatedAt: new Date() } }, { returnDocument: "after" });
        if (!result)
            return void res.status(404).json({ error: "Note not found" });
        res.json(result);
    }
    catch (error) {
        res.status(500).json({ error: error.message || "Failed to update visibility" });
    }
});
// ─── DELETE /notes/:id ───────────────────────────────────────
app.delete("/notes/:id", async (req, res) => {
    try {
        const session = await getSession(req);
        if (!session)
            return void res.status(401).json({ error: "Unauthorized" });
        const notesCollection = await getNotesCollection();
        const result = await notesCollection.deleteOne({
            _id: new ObjectId(req.params.id),
            userId: session.user.id,
        });
        if (result.deletedCount === 0)
            return void res.status(404).json({ error: "Note not found" });
        res.json({ success: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message || "Failed to delete note" });
    }
});
// ─── Global Error Handler ──────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error("Express Global Error Handler:", err);
    res.status(500).json({ error: err.message || "Internal Server Error" });
});
// ─── Server Start (Local Dev) ──────────────────────────────────
const PORT = process.env.PORT || 11111;
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`Server running on Port ${PORT}`);
    });
}
export default app;
