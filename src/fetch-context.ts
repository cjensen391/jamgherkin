import dotenv from "dotenv";

dotenv.config();

const jamUrl = process.argv[2] || "https://jam.dev/c/74d92fb2-cb25-4d46-ae14-ce4cf3c5b39d";
const token = process.env.JAM_TOKEN;

async function getContext() {
    console.log(`Fetching context for: ${jamUrl}`);
    // Jam MCP server endpoint usually handles tool calls via POST.
    // Let's try to call the 'get_jam' tool directly via POST.
    try {
        const res = await fetch("https://mcp.jam.dev/mcp", {
            method: 'POST',
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "tools/call",
                params: {
                    name: "get_jam",
                    arguments: { url: jamUrl }
                },
                id: 1
            })
        });

        console.log("Status:", res.status);
        const data = await res.json();
        console.log("Context retrieved!");
        console.log(JSON.stringify(data, null, 2));
    } catch (err) {
        console.error("Error fetching context:", err);
    }
}

getContext();
