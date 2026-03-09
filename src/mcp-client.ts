import dotenv from "dotenv";
dotenv.config();

export interface JamMetadata {
    id: string;
    title: string;
    url: string;
    author: string;
    createdAt: string;
}

export class JamMcpClient {
    private token: string;
    private url: string = "https://mcp.jam.dev/mcp";
    private sessionId: string | null = null;

    constructor() {
        this.token = process.env.JAM_TOKEN || "";
    }

    private async ensureSession() {
        if (this.sessionId) return;

        const res = await fetch(this.url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream"
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "initialize",
                params: {
                    protocolVersion: "2024-11-05",
                    capabilities: {},
                    clientInfo: { name: "jamgherkin", version: "1.0.0" }
                },
                id: 1
            })
        });

        if (!res.ok) {
            throw new Error(`Failed to initialize Jam MCP session: ${res.status} ${res.statusText}`);
        }

        this.sessionId = res.headers.get("mcp-session-id");
        if (!this.sessionId) {
            throw new Error("No mcp-session-id returned from Jam MCP server");
        }

        // Send initialized notification
        await fetch(this.url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "mcp-session-id": this.sessionId || ""
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized"
            })
        });
    }

    async listJams(limit: number = 10): Promise<JamMetadata[]> {
        await this.ensureSession();

        const res = await fetch(this.url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "mcp-session-id": this.sessionId!
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    name: "listJams",
                    arguments: { limit }
                },
                id: Date.now()
            })
        });

        const text = await res.text();
        const lines = text.split("\n");
        for (const line of lines) {
            if (line.startsWith("data: ")) {
                const json = JSON.parse(line.slice(6));
                if (json.result?.content?.[0]?.text) {
                    try {
                        // The tool returns text, which might be JSON or a list.
                        // Based on the 'listJams' description, it returns Jam metadata.
                        const toolsResult = JSON.parse(json.result.content[0].text);
                        return toolsResult;
                    } catch (e) {
                        // Fallback if it's not JSON
                        console.error("Could not parse listJams content as JSON:", json.result.content[0].text);
                    }
                }
            }
        }
        return [];
    }

    async getJamContext(
        jamIdOrUrl: string,
        networkFilters: {
            statusCode?: string | number | undefined;
            contentType?: string | undefined;
            host?: string | undefined;
            limit?: number | undefined;
        } = {}
    ): Promise<string> {
        await this.ensureSession();

        const fetchTool = async (name: string, extraParams: object = {}) => {
            console.log(`   - Calling tool: ${name}...`);
            const res = await fetch(this.url, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${this.token}`,
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                    "mcp-session-id": this.sessionId || ""
                },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    method: "tools/call",
                    params: {
                        name,
                        arguments: { jamId: jamIdOrUrl, ...extraParams }
                    },
                    id: `${Date.now()}-${name}`
                })
            });

            if (!res.body) return "";
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let resultText = "";
            let buffer = "";

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    if (line.startsWith("data: ")) {
                        try {
                            const json = JSON.parse(line.slice(6));
                            if (json.result?.content?.[0]?.text) {
                                let text = json.result.content[0].text;
                                if (text.length > 20000) {
                                    text = text.substring(0, 20000) + "... (truncated)";
                                }
                                resultText = text;
                            }
                        } catch (e) { }
                    }
                }
                // If we got a result, we can probably stop reading for this specific tool call
                if (resultText) break;
            }
            reader.cancel().catch(() => { });
            return resultText;
        };

        const [events, logs, network] = await Promise.all([
            fetchTool("getUserEvents", { limit: 100 }), // Limit events too
            fetchTool("getConsoleLogs", { limit: 20 }),
            fetchTool("getNetworkRequests", {
                limit: networkFilters.limit || 20,
                statusCode: networkFilters.statusCode,
                contentType: networkFilters.contentType,
                host: networkFilters.host
            })
        ]);

        console.log(`   - Context sizes: Events=${events.length}, Logs=${logs.length}, Network=${network.length}`);

        let context = `--- USER EVENTS ---\n${events}\n\n`;
        context += `--- CONSOLE LOGS ---\n${logs}\n\n`;
        context += `--- NETWORK REQUESTS ---\n${network}\n`;

        if (!events && !logs && !network) {
            throw new Error("Failed to retrieve any Jam context via MCP tools");
        }

        return context;
    }

    async searchJams(query: string): Promise<JamMetadata[]> {
        await this.ensureSession();

        const res = await fetch(this.url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.token}`,
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                "mcp-session-id": this.sessionId!
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    name: "search",
                    arguments: { query }
                },
                id: Date.now()
            })
        });

        const text = await res.text();
        const lines = text.split("\n");
        for (const line of lines) {
            if (line.startsWith("data: ")) {
                const json = JSON.parse(line.slice(6));
                if (json.result?.content?.[0]?.text) {
                    try {
                        const searchResult = JSON.parse(json.result.content[0].text);
                        // The search tool returns an object with a 'results' array
                        return searchResult.results || searchResult.jams || (Array.isArray(searchResult) ? searchResult : []);
                    } catch (e) {
                        console.error("Could not parse search result as JSON:", json.result.content[0].text);
                    }
                }
            }
        }
        return [];
    }
}
