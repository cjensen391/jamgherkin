import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { EventSource } from "eventsource";
import dotenv from "dotenv";

dotenv.config();

export class JamMcpClient {
    private client: Client;
    private transport: SSEClientTransport;

    constructor() {
        const url = new URL("https://mcp.jam.dev/mcp");
        this.transport = new SSEClientTransport(url, {
            eventSourceInit: {
                headers: {
                    "Authorization": `Bearer ${process.env.JAM_TOKEN}`
                }
            } as any
        });
        this.client = new Client(
            { name: "jam-test-gen", version: "1.0.0" },
            { capabilities: {} }
        );
    }

    async connect() {
        await this.client.connect(this.transport);
        console.log("Connected to Jam MCP");
    }

    async listTools() {
        return await this.client.listTools();
    }

    async callTool(name: string, args: any) {
        return await this.client.callTool({ name, arguments: args });
    }

    async disconnect() {
        await this.transport.close();
    }
}
