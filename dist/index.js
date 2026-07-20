"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const mongodb_1 = require("mongodb");
const node_1 = require("better-auth/node");
const auth_js_1 = require("./auth.js");
const gemini_js_1 = require("./gemini.js");
// @ts-ignore
const pdf_parse_1 = __importDefault(require("pdf-parse"));
async function extractPdfText(buffer) {
    const pdfParseMod = pdf_parse_1.default;
    if (typeof pdfParseMod === "function") {
        const res = await pdfParseMod(buffer);
        return res.text ?? "";
    }
    if (pdfParseMod?.default && typeof pdfParseMod.default === "function") {
        const res = await pdfParseMod.default(buffer);
        return res.text ?? "";
    }
    if (pdfParseMod?.PDFParse) {
        const parser = new pdfParseMod.PDFParse({ data: buffer });
        const res = await parser.getText();
        if (typeof parser.destroy === "function")
            parser.destroy();
        return res.text ?? "";
    }
    throw new Error("Could not initialize PDF parser");
}
const mammoth_1 = __importDefault(require("mammoth"));
// @ts-ignore
const multer_1 = __importDefault(require("multer"));
dotenv_1.default.config();
const upload = (0, multer_1.default)({ limits: { fileSize: 10 * 1024 * 1024 } });
const app = (0, express_1.default)();
// ─── Middleware ───────────────────────────────────────────────
app.use((0, cors_1.default)({ origin: process.env.CLIENT_URL, credentials: true }));
app.all("/api/auth/{*any}", (0, node_1.toNodeHandler)(auth_js_1.auth));
app.use(express_1.default.json());
// ─── MongoDB Connection ───────────────────────────────────────
const client = new mongodb_1.MongoClient(process.env.MONGODB_URI, {
    serverApi: {
        version: mongodb_1.ServerApiVersion.v1,
        strict: false,
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
        const getSession = (req) => auth_js_1.auth.api.getSession({ headers: (0, node_1.fromNodeHeaders)(req.headers) });
        // ─── POST /generate-notes ─────────────────────────────────
        app.post("/generate-notes", async (req, res) => {
            try {
                const session = await getSession(req);
                if (!session)
                    return void res.status(401).json({ error: "Unauthorized" });
                const { topic, subject, keywords = [], difficulty = "Beginner", outputLength = "Medium", writingStyle = "Simple", feedback, previousNote, } = req.body;
                if (!topic || !subject) {
                    return void res.status(400).json({ error: "Topic and subject are required" });
                }
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
                const result = await (0, gemini_js_1.generateStudyNote)({
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
        // ─── POST /analyze-notes ──────────────────────────────────
        // FIX: আগে new PDFParse() ব্যবহার হতো যেটা কাজ করে না
        // এখন সঠিকভাবে await pdfParse(buffer) use করছে
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
                    const parsed = await mammoth_1.default.extractRawText({ buffer: request.file.buffer });
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
                const result = await (0, gemini_js_1.analyzeDocumentText)(extractedText);
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
                const insertResult = await notesCollection.insertOne(noteDoc);
                res.json({ ...result, _id: insertResult.insertedId, visibility: "private" });
            }
            catch (error) {
                console.error("Error analyzing notes:", error);
                res.status(500).json({ error: error.message || "Failed to analyze document" });
            }
        });
        // ─── POST /notes ──────────────────────────────────────────
        app.post("/notes", async (req, res) => {
            const session = await getSession(req);
            if (!session)
                return void res.status(401).json({ error: "Unauthorized" });
            const { title, content, shortDescription, thumbnail, subject, difficulty, keywords, summary, practiceQuestions, source, visibility = "public" } = req.body;
            if (!title || !content)
                return void res.status(400).json({ error: "Title and content required" });
            const note = { title, content, shortDescription, thumbnail, subject, difficulty, keywords, summary, practiceQuestions, source, visibility, userId: session.user.id, userName: session.user.name, createdAt: new Date(), updatedAt: new Date() };
            const result = await notesCollection.insertOne(note);
            res.status(201).json({ ...note, _id: result.insertedId });
        });
        // ─── GET /notes/subjects ──────────────────────────────────
        app.get("/notes/subjects", async (_req, res) => {
            const subjects = await notesCollection.distinct("subject", { visibility: "public" });
            res.json({ subjects: subjects.filter(Boolean) });
        });
        // ─── GET /notes ───────────────────────────────────────────
        app.get("/notes", async (req, res) => {
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
            const [notes, total] = await Promise.all([
                notesCollection.find(filter).sort(sortOrder).skip(skip).limit(Number(limit)).toArray(),
                notesCollection.countDocuments(filter),
            ]);
            res.json({ notes, total });
        });
        // ─── GET /my-notes ────────────────────────────────────────
        app.get("/my-notes", async (req, res) => {
            const session = await getSession(req);
            if (!session)
                return void res.status(401).json({ error: "Unauthorized" });
            const notes = await notesCollection.find({ userId: session.user.id }).sort({ createdAt: -1 }).toArray();
            res.json(notes);
        });
        // ─── GET /notes/:id ───────────────────────────────────────
        app.get("/notes/:id", async (req, res) => {
            const note = await notesCollection.findOne({ _id: new mongodb_1.ObjectId(req.params.id) });
            if (!note)
                return void res.status(404).json({ error: "Note not found" });
            res.json(note);
        });
        // ─── PATCH /notes/:id ────────────────────────────────────
        app.patch("/notes/:id", async (req, res) => {
            const session = await getSession(req);
            if (!session)
                return void res.status(401).json({ error: "Unauthorized" });
            const { title, content } = req.body;
            const result = await notesCollection.findOneAndUpdate({ _id: new mongodb_1.ObjectId(req.params.id), userId: session.user.id }, { $set: { title, content, updatedAt: new Date() } }, { returnDocument: "after" });
            if (!result)
                return void res.status(404).json({ error: "Note not found" });
            res.json(result);
        });
        // ─── PATCH /notes/:id/visibility ─────────────────────────
        app.patch("/notes/:id/visibility", async (req, res) => {
            const session = await getSession(req);
            if (!session)
                return void res.status(401).json({ error: "Unauthorized" });
            const { visibility } = req.body;
            if (!["public", "private"].includes(visibility))
                return void res.status(400).json({ error: "visibility must be public or private" });
            const result = await notesCollection.findOneAndUpdate({ _id: new mongodb_1.ObjectId(req.params.id), userId: session.user.id }, { $set: { visibility, updatedAt: new Date() } }, { returnDocument: "after" });
            if (!result)
                return void res.status(404).json({ error: "Note not found" });
            res.json(result);
        });
        // ─── DELETE /notes/:id ───────────────────────────────────
        app.delete("/notes/:id", async (req, res) => {
            const session = await getSession(req);
            if (!session)
                return void res.status(401).json({ error: "Unauthorized" });
            const result = await notesCollection.deleteOne({
                _id: new mongodb_1.ObjectId(req.params.id),
                userId: session.user.id,
            });
            if (result.deletedCount === 0)
                return void res.status(404).json({ error: "Note not found" });
            res.json({ success: true });
        });
    }
    catch (error) {
        console.log(error);
        await client.close();
    }
};
run();
// ─── Health Check ─────────────────────────────────────────────
app.get("/", (_req, res) => {
    res.send("StudySage AI Server is Online");
});
// ─── Server Start ─────────────────────────────────────────────
app.listen(process.env.PORT, () => {
    console.log(`Server running on Port ${process.env.PORT}`);
});
