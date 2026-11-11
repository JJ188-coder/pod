import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * 可编程的假 Magpie 上游，仅用于测试。
 * state.generateCalls 统计真实生成调用次数；测试据此断言没有重复提交。
 */
export function createFakeMagpie() {
  const state = {
    generateCalls: 0,
    resultCalls: 0,
    generateArgs: [],
    /** 每次 generate 依次取一个；用完后重复使用最后一项。 */
    generateResponses: [],
    resultResponses: [],
    imageDownloads: 0,
    imageFailuresLeft: 0,
    onGenerate: null,
    onResult: null,
  };

  const next = (list, label) => {
    if (!list.length) throw new Error(`fake magpie: ${label} 没有配置响应`);
    return list.length > 1 ? list.shift() : list[0];
  };

  const httpServer = createServer(async (req, res) => {
    if (req.url?.startsWith("/img/")) {
      state.imageDownloads += 1;
      if (state.imageFailuresLeft > 0) {
        state.imageFailuresLeft -= 1;
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("boom");
        return;
      }
      res.writeHead(200, { "content-type": "image/png", "content-length": TINY_PNG.length });
      res.end(TINY_PNG);
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }

    const server = new McpServer({ name: "fake-magpie", version: "1.0.0" });

    server.registerTool(
      "generate_image",
      {
        title: "generate",
        inputSchema: {
          prompt: z.string(),
          n: z.number().optional(),
          size: z.string().optional(),
          quality: z.string().optional(),
          background: z.string().optional(),
          model: z.string().optional(),
          reference_images: z.array(z.string()).optional(),
        },
      },
      async (args) => {
        state.generateCalls += 1;
        state.generateArgs.push(args);
        const response = state.onGenerate ? await state.onGenerate(args) : next(state.generateResponses, "generateResponses");
        if (response.throwError) throw new Error(response.throwError);
        return response.result ?? response;
      },
    );

    server.registerTool(
      "generation_result",
      { title: "result", inputSchema: { id: z.string() } },
      async (args) => {
        state.resultCalls += 1;
        const response = state.onResult ? await state.onResult(args) : next(state.resultResponses, "resultResponses");
        if (response.throwError) throw new Error(response.throwError);
        return response.result ?? response;
      },
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close().catch(() => undefined);
      server.close().catch(() => undefined);
    });

    await server.connect(transport);
    await transport.handleRequest(req, res);
  });

  return {
    state,
    async start() {
      await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
      const { port } = httpServer.address();
      return {
        port,
        endpoint: `http://127.0.0.1:${port}/mcp/magpie/image`,
        imageUrl: (name) => `http://127.0.0.1:${port}/img/${name}`,
        stop: async () => {
          httpServer.closeAllConnections?.();
          await new Promise((resolve) => httpServer.close(resolve));
        },
      };
    },
    async stop() {
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}

export function textResult(payload) {
  return {
    content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }],
  };
}

export function inlineImageResult(payload, base64 = TINY_PNG.toString("base64")) {
  return {
    content: [
      { type: "image", data: base64, mimeType: "image/png" },
      { type: "text", text: JSON.stringify(payload) },
    ],
  };
}
