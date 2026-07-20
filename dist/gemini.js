"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateStudyNote = generateStudyNote;
exports.analyzeDocumentText = analyzeDocumentText;
const dotenv_1 = __importDefault(require("dotenv"));
const genai_1 = require("@google/genai");
dotenv_1.default.config();
const ai = new genai_1.GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = "gemini-3.1-flash-lite";
const outputLengthMap = {
    Short: "~300 words, a concise overview",
    Medium: "~800 words, a balanced study note",
    Long: "~1500 words, a comprehensive in-depth guide",
};
const studyNoteSchema = {
    type: genai_1.Type.OBJECT,
    properties: {
        title: { type: genai_1.Type.STRING, description: "Detailed, engaging title for the study note" },
        summary: { type: genai_1.Type.STRING, description: "A concise summary/overview of the topic" },
        content: { type: genai_1.Type.STRING, description: "Comprehensive, in-depth study note content in GitHub Flavored Markdown format" },
        keyTakeaways: {
            type: genai_1.Type.ARRAY,
            items: { type: genai_1.Type.STRING },
            description: "List of key takeaways or core concepts"
        },
        practiceQuestions: {
            type: genai_1.Type.ARRAY,
            items: { type: genai_1.Type.STRING },
            description: "List of 3-5 practice questions to test understanding"
        }
    },
    required: ["title", "summary", "content", "keyTakeaways", "practiceQuestions"]
};
const analysisSchema = {
    type: genai_1.Type.OBJECT,
    properties: {
        summary: { type: genai_1.Type.STRING, description: "Concise summary of the document" },
        keyPoints: {
            type: genai_1.Type.ARRAY,
            items: { type: genai_1.Type.STRING },
            description: "Main key points from the document"
        },
        importantTerms: {
            type: genai_1.Type.ARRAY,
            items: {
                type: genai_1.Type.OBJECT,
                properties: {
                    term: { type: genai_1.Type.STRING, description: "The term or concept name" },
                    definition: { type: genai_1.Type.STRING, description: "Definition of the term" }
                },
                required: ["term", "definition"]
            },
            description: "Important terms, vocabulary, or concepts with their definitions"
        },
        practiceQuestions: {
            type: genai_1.Type.ARRAY,
            items: { type: genai_1.Type.STRING },
            description: "List of practice questions based on the content"
        },
        actionItems: {
            type: genai_1.Type.ARRAY,
            items: { type: genai_1.Type.STRING },
            description: "List of actionable next steps or key study goals based on the content"
        }
    },
    required: ["summary", "keyPoints", "importantTerms", "practiceQuestions", "actionItems"]
};
function buildPrompt(params) {
    const parts = [];
    parts.push(`You are an expert academic tutor creating a structured study note.`);
    parts.push(`Topic: ${params.topic}`);
    parts.push(`Subject: ${params.subject}`);
    if (params.keywords.length > 0) {
        parts.push(`Keywords to cover: ${params.keywords.join(", ")}`);
    }
    const lengthGuide = outputLengthMap[params.outputLength] ?? outputLengthMap.Medium;
    parts.push(`Output length: ${lengthGuide}.`);
    const styleGuides = {
        Academic: "Use formal academic language with precise terminology.",
        Simple: "Use simple, easy-to-understand language suitable for beginners.",
        "Exam Ready": "Focus on test-relevant facts, definitions, and likely exam questions.",
    };
    parts.push(`Writing style: ${params.writingStyle}. ${styleGuides[params.writingStyle] ?? ""}`);
    const diffGuides = {
        Beginner: "Assume no prior knowledge. Explain foundational concepts first.",
        Intermediate: "Assume basic familiarity. Focus on deeper understanding and connections.",
        Advanced: "Assume strong background. Cover edge cases, advanced theory, and research-level insights.",
    };
    parts.push(`Difficulty level: ${params.difficulty}. ${diffGuides[params.difficulty] ?? ""}`);
    if (params.memory && params.memory.length > 0) {
        parts.push(`\nThe user has previously studied these related notes (use as context for continuity, but do not copy):`);
        for (const prev of params.memory) {
            parts.push(`- "${prev.title}" (${prev.subject}): ${prev.summary}`);
        }
    }
    if (params.feedback) {
        parts.push(`\nThe user provided feedback to refine this note: "${params.feedback}"`);
    }
    if (params.previousNote) {
        parts.push(`\nThe user is regenerating from a previous attempt. Previous note reference: "${params.previousNote}". Improve upon it.`);
    }
    return parts.join("\n");
}
async function critiqueAndRefine(draft, params) {
    const critiquePrompt = `You are a quality reviewer for AI-generated study notes. Review the following note and refine it to improve accuracy, clarity, and match with the requested parameters.

Original request:
- Topic: ${params.topic}
- Subject: ${params.subject}
- Difficulty: ${params.difficulty}
- Writing Style: ${params.writingStyle}
- Output Length: ${params.outputLength}
${params.feedback ? `- User feedback: "${params.feedback}"` : ""}

Note to review:
Title: ${draft.title}
Summary: ${draft.summary}
Content: ${draft.content.substring(0, 500)}...

Key Takeaways: ${draft.keyTakeaways.join("; ")}
Practice Questions: ${draft.practiceQuestions.join("; ")}

Check for:
1. Does the content match the requested difficulty level?
2. Does the writing style match the requested style?
3. Is the content accurate and well-structured?
4. Are the key takeaways truly key points?
5. Are the practice questions relevant and answerable?`;
    const resp = await ai.models.generateContent({
        model: MODEL,
        contents: critiquePrompt,
        config: {
            temperature: 0.3,
            responseMimeType: "application/json",
            responseSchema: studyNoteSchema,
        },
    });
    const text = resp.text ?? resp.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text)
        return draft;
    try {
        return JSON.parse(text);
    }
    catch {
        return draft;
    }
}
async function generateStudyNote(params) {
    const prompt = buildPrompt(params);
    const firstResp = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
            temperature: 0.7,
            responseMimeType: "application/json",
            responseSchema: studyNoteSchema,
        },
    });
    const firstText = firstResp.text ?? firstResp.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!firstText)
        throw new Error("No response from AI model");
    const draft = JSON.parse(firstText);
    const refined = await critiqueAndRefine(draft, params);
    return refined;
}
async function analyzeDocumentText(text) {
    const prompt = `You are an expert academic tutor. Analyze the specific document text below and extract structured insights that are UNIQUE to this document. Do NOT use generic or boilerplate answers — every point must be directly drawn from the given text.

Document text:
${text.substring(0, 15000)}`;
    const resp = await ai.models.generateContent({
        model: MODEL,
        contents: prompt,
        config: {
            temperature: 0.4,
            responseMimeType: "application/json",
            responseSchema: analysisSchema,
        },
    });
    const respText = resp.text ?? resp.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!respText)
        throw new Error("No response from AI model");
    return JSON.parse(respText);
}
