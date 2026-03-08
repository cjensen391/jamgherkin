import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { EventSource } from "eventsource";
import dotenv from "dotenv";

dotenv.config();

async function main() {
    const transport = new SSEClientTransport(new URL("https://mcp.jam.dev/mcp"), {
        eventSourceInit: {
            headers: {
                "Authorization": `Bearer ${process.env.JAM_TOKEN}`
            }
        } as any
    });
    const client = new Client(
        {
            name: "jam-explorer",
            version: "1.0.0",
        },
        {
            capabilities: {},
        }
    );

    await client.connect(transport);

    console.log("Connected to Jam MCP server");

    const tools = await client.listTools();
    console.log("\nTools:");
    console.log(JSON.stringify(tools, null, 2));

    const resources = await client.listResources();
    console.log("\nResources:");
    console.log(JSON.stringify(resources, null, 2));
}

main().catch(console.error);
