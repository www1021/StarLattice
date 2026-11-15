import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun
} from "docx";
import pptxgen from "pptxgenjs";

export type ArtifactType = "md" | "docx" | "pptx";

export type ArtifactRequest = {
  name: string;
  type: ArtifactType;
  title?: string;
  content?: string;
  sections?: Array<{
    heading?: string;
    body?: string;
    bullets?: string[];
  }>;
  slides?: Array<{
    title?: string;
    bullets?: string[];
    notes?: string;
  }>;
};

export type GeneratedArtifact = {
  id: string;
  name: string;
  type: ArtifactType;
  url: string;
  size: number;
};

type SlideData = {
  title?: string;
  bullets?: string[];
  notes?: string;
};

const projectRoot = process.cwd();
const generatedDir = path.join(projectRoot, "generated");

export function getGeneratedFilePath(id: string) {
  return path.join(generatedDir, id);
}

export async function generateArtifacts(
  requests: ArtifactRequest[]
): Promise<GeneratedArtifact[]> {
  await mkdir(generatedDir, { recursive: true });
  const generated: GeneratedArtifact[] = [];

  for (const request of requests) {
    const type = normalizeType(request.type);

    if (!type) {
      continue;
    }

    const name = ensureExtension(sanitizeFileName(request.name), type);
    const id = `${randomUUID()}-${name}`;
    const outputPath = getGeneratedFilePath(id);

    if (type === "md") {
      await writeFile(outputPath, renderMarkdown(request), "utf8");
    }

    if (type === "docx") {
      await writeFile(outputPath, await renderDocx(request));
    }

    if (type === "pptx") {
      await renderPptx(request, outputPath);
    }

    const fileStats = await stat(outputPath);
    generated.push({
      id,
      name,
      type,
      url: `/api/files/${encodeURIComponent(id)}`,
      size: fileStats.size
    });
  }

  return generated;
}

function normalizeType(type: string): ArtifactType | null {
  if (type === "md" || type === "docx" || type === "pptx") {
    return type;
  }

  return null;
}

function sanitizeFileName(name: string) {
  return (name || "生成文件")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function ensureExtension(name: string, type: ArtifactType) {
  const extension = `.${type}`;
  return name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`;
}

function renderMarkdown(request: ArtifactRequest) {
  const lines: string[] = [`# ${request.title || stripExtension(request.name)}`];

  if (request.content) {
    lines.push("", request.content);
  }

  for (const section of request.sections || []) {
    if (section.heading) {
      lines.push("", `## ${section.heading}`);
    }

    if (section.body) {
      lines.push("", section.body);
    }

    for (const bullet of section.bullets || []) {
      lines.push(`- ${bullet}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function renderDocx(request: ArtifactRequest) {
  const children: Paragraph[] = [
    new Paragraph({
      text: request.title || stripExtension(request.name),
      heading: HeadingLevel.TITLE
    })
  ];

  if (request.content) {
    children.push(...paragraphsFromText(request.content));
  }

  for (const section of request.sections || []) {
    if (section.heading) {
      children.push(
        new Paragraph({
          text: section.heading,
          heading: HeadingLevel.HEADING_1
        })
      );
    }

    if (section.body) {
      children.push(...paragraphsFromText(section.body));
    }

    for (const bullet of section.bullets || []) {
      children.push(
        new Paragraph({
          children: [new TextRun(bullet)],
          bullet: { level: 0 }
        })
      );
    }
  }

  const document = new Document({
    sections: [{ children }]
  });

  return Packer.toBuffer(document);
}

async function renderPptx(request: ArtifactRequest, outputPath: string) {
  const pptx = new pptxgen();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "YiJiaoXun";
  pptx.subject = request.title || stripExtension(request.name);
  pptx.title = request.title || stripExtension(request.name);
  pptx.company = "YiJiaoXun";
  pptx.theme = {
    headFontFace: "Microsoft YaHei",
    bodyFontFace: "Microsoft YaHei"
  };

  const slides: SlideData[] | undefined = request.slides?.length
    ? request.slides
    : request.sections?.map((section) => ({
        title: section.heading,
        bullets: section.bullets?.length
          ? section.bullets
          : section.body
            ? [section.body]
            : []
      }));

  for (const slideData of slides?.length ? slides : [{ title: request.title }]) {
    const slide = pptx.addSlide();
    slide.background = { color: "F7F9FB" };
    slide.addText(slideData.title || request.title || stripExtension(request.name), {
      x: 0.65,
      y: 0.45,
      w: 11.0,
      h: 0.55,
      fontFace: "Microsoft YaHei",
      fontSize: 28,
      bold: true,
      color: "20252B"
    });
    slide.addText((slideData.bullets || []).map((text) => `• ${text}`).join("\n"), {
      x: 0.85,
      y: 1.35,
      w: 10.6,
      h: 4.8,
      fontFace: "Microsoft YaHei",
      fontSize: 18,
      breakLine: false,
      fit: "shrink",
      color: "2F3845"
    });

    if (slideData.notes) {
      slide.addNotes(slideData.notes);
    }
  }

  await pptx.writeFile({ fileName: outputPath });
}

function paragraphsFromText(text: string) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(
      (line) =>
        new Paragraph({
          children: [new TextRun(line)]
        })
    );
}

function stripExtension(name: string) {
  return name.replace(/\.(md|docx|pptx)$/i, "");
}
