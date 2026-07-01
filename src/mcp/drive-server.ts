import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { SafeDriveClient } from "../drive/client.js";
import { extractDriveId } from "../drive/id.js";

const drive = new SafeDriveClient();

const server = new Server(
  { name: "canon-quill-drive", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "extract_id",
      description: "Extract a Google Drive file or folder ID from a Drive URL or raw ID.",
      inputSchema: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"]
      }
    },
    {
      name: "list_folder",
      description: "List files in a selected Google Drive folder. Does not read file contents.",
      inputSchema: {
        type: "object",
        properties: { folderId: { type: "string" } },
        required: ["folderId"]
      }
    },
    {
      name: "read_file_text",
      description: "Read or export a selected Google Drive file as text.",
      inputSchema: {
        type: "object",
        properties: { fileId: { type: "string" } },
        required: ["fileId"]
      }
    },
    {
      name: "write_text_file",
      description: "Create a new text/Markdown file in a selected target Drive folder. Refuses overwrite by default.",
      inputSchema: {
        type: "object",
        properties: {
          folderId: { type: "string" },
          name: { type: "string" },
          content: { type: "string" },
          mimeType: { type: "string" },
          overwrite: { type: "boolean" }
        },
        required: ["folderId", "name", "content"]
      }
    },
    {
      name: "upsert_text_file",
      description: "Create or update a text/Markdown file in a selected target Drive folder. Overwrite must be explicit or enabled by env.",
      inputSchema: {
        type: "object",
        properties: {
          folderId: { type: "string" },
          name: { type: "string" },
          content: { type: "string" },
          mimeType: { type: "string" },
          overwrite: { type: "boolean" }
        },
        required: ["folderId", "name", "content"]
      }
    },
    {
      name: "upload_binary_file",
      description: "Upload a binary file from base64 content to a selected target Drive folder. Refuses overwrite by default.",
      inputSchema: {
        type: "object",
        properties: {
          folderId: { type: "string" },
          name: { type: "string" },
          base64Content: { type: "string" },
          mimeType: { type: "string" },
          overwrite: { type: "boolean" }
        },
        required: ["folderId", "name", "base64Content", "mimeType"]
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "extract_id") {
    const input = z.object({ input: z.string() }).parse(args);
    return jsonContent({ id: extractDriveId(input.input) });
  }

  if (name === "list_folder") {
    const input = z.object({ folderId: z.string() }).parse(args);
    return jsonContent({ files: await drive.listFolder(input.folderId) });
  }

  if (name === "read_file_text") {
    const input = z.object({ fileId: z.string() }).parse(args);
    return jsonContent({ text: await drive.readFileText(input.fileId) });
  }

  if (name === "write_text_file" || name === "upsert_text_file") {
    const input = z
      .object({
        folderId: z.string(),
        name: z.string(),
        content: z.string(),
        mimeType: z.string().optional(),
        overwrite: z.boolean().optional()
      })
      .parse(args);
    return jsonContent({ file: await drive.writeTextFile(input) });
  }

  if (name === "upload_binary_file") {
    const input = z
      .object({
        folderId: z.string(),
        name: z.string(),
        base64Content: z.string(),
        mimeType: z.string(),
        overwrite: z.boolean().optional()
      })
      .parse(args);
    return jsonContent({ file: await drive.uploadBinaryFile(input) });
  }

  throw new Error(`Unknown tool: ${name}`);
});

function jsonContent(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

const transport = new StdioServerTransport();
await server.connect(transport);
