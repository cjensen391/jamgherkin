import dotenv from "dotenv";

dotenv.config();

const url = "https://mcp.jam.dev/mcp";
const token = process.env.JAM_TOKEN;

async function testPost() {
    console.log("Testing POST to initialize session...");
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                jsonrpc: "2.0",
                method: "initialize",
                params: {
                    protocolVersion: "2024-11-05",
                    capabilities: {},
                    clientInfo: { name: "test", version: "1.0.0" }
                },
                id: 1
            })
        });
        console.log("Status:", res.status);
        console.log("Status Text:", res.statusText);
        const body = await res.text();
        console.log("Body:", body);
        console.log("Headers:", JSON.stringify(Object.fromEntries(res.headers.entries()), null, 2));
    } catch (err) {
        console.error("Post error:", err);
    }
}

testPost();
