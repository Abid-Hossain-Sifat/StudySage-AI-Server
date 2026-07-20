import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";

dotenv.config();

export interface GeneratedNoteOutput {
  title: string;
  summary: string;
  content: string;
  keyTakeaways: string[];
  practiceQuestions: string[];
}

export interface AnalyzedDocumentOutput {
  summary: string;
  keyPoints: string[];
  importantTerms: { term: string; definition: string }[];
  practiceQuestions: string[];
  actionItems: string[];
}

interface GenerateStudyNoteParams {
  topic: string;
  subject: string;
  keywords: string[];
  difficulty: string;
  outputLength: string;
  writingStyle: string;
  memory: { title: string; subject: string; summary: string }[];
  feedback?: string;
  previousNote?: string;
}

function getAI() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing in environment variables");
  }
  return new GoogleGenAI({ apiKey });
}

const MODEL = "gemini-3.1-flash-lite";

const outputLengthMap: Record<string, string> = {
  Short: "~300 words, a concise overview",
  Medium: "~800 words, a balanced study note",
  Long: "~1500 words, a comprehensive in-depth guide",
};

const studyNoteSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: "Detailed, engaging title for the study note" },
    summary: { type: Type.STRING, description: "A concise summary/overview of the topic" },
    content: { type: Type.STRING, description: "Comprehensive, in-depth study note content in GitHub Flavored Markdown format" },
    keyTakeaways: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "List of key takeaways or core concepts"
    },
    practiceQuestions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "List of 3-5 practice questions to test understanding"
    }
  },
  required: ["title", "summary", "content", "keyTakeaways", "practiceQuestions"]
};

const analysisSchema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING, description: "Concise summary of the document" },
    keyPoints: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Main key points from the document"
    },
    importantTerms: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          term: { type: Type.STRING, description: "The term or concept name" },
          definition: { type: Type.STRING, description: "Definition of the term" }
        },
        required: ["term", "definition"]
      },
      description: "Important terms, vocabulary, or concepts with their definitions"
    },
    practiceQuestions: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "List of practice questions based on the content"
    },
    actionItems: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "List of actionable next steps or key study goals based on the content"
    }
  },
  required: ["summary", "keyPoints", "importantTerms", "practiceQuestions", "actionItems"]
};

function buildPrompt(params: GenerateStudyNoteParams): string {
  const parts: string[] = [];

  parts.push(`You are an expert academic tutor creating a structured study note.`);

  parts.push(`Topic: ${params.topic}`);
  parts.push(`Subject: ${params.subject}`);
  if (params.keywords.length > 0) {
    parts.push(`Keywords to cover: ${params.keywords.join(", ")}`);
  }

  const lengthGuide = outputLengthMap[params.outputLength] ?? outputLengthMap.Medium;
  parts.push(`Output length: ${lengthGuide}.`);

  const styleGuides: Record<string, string> = {
    Academic: "Use formal academic language with precise terminology.",
    Simple: "Use simple, easy-to-understand language suitable for beginners.",
    "Exam Ready": "Focus on test-relevant facts, definitions, and likely exam questions.",
  };
  parts.push(`Writing style: ${params.writingStyle}. ${styleGuides[params.writingStyle] ?? ""}`);

  const diffGuides: Record<string, string> = {
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

async function critiqueAndRefine(
  draft: GeneratedNoteOutput,
  params: GenerateStudyNoteParams,
): Promise<GeneratedNoteOutput> {
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

  const ai = getAI();
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
  if (!text) return draft;
  try {
    return JSON.parse(text) as GeneratedNoteOutput;
  } catch {
    return draft;
  }
}

export async function generateStudyNote(
  params: GenerateStudyNoteParams,
): Promise<GeneratedNoteOutput> {
  const prompt = buildPrompt(params);
  const ai = getAI();

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
  if (!firstText) throw new Error("No response from AI model");

  const draft = JSON.parse(firstText) as GeneratedNoteOutput;
  const refined = await critiqueAndRefine(draft, params);
  return refined;
}

export async function analyzeDocumentText(
  text: string,
): Promise<AnalyzedDocumentOutput> {
  const prompt = `You are an expert academic tutor. Analyze the specific document text below and extract structured insights that are UNIQUE to this document. Do NOT use generic or boilerplate answers — every point must be directly drawn from the given text.

Document text:
${text.substring(0, 15000)}`;

  const ai = getAI();
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
  if (!respText) throw new Error("No response from AI model");

  return JSON.parse(respText) as AnalyzedDocumentOutput;
}
