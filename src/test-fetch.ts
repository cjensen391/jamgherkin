import dotenv from "dotenv";

dotenv.config();

const url = "https://mcp.jam.dev/mcp";
const token = process.env.JAM_TOKEN;

async function testFetch() {
    console.log("Testing with fetch...");
    try {
        const res = await fetch(url, {
            headers: {
                "Authorization": `Bearer ${token}`
            }
        });
        console.log("Status:", res.status);
        console.log("Status Text:", res.statusText);
        const body = await res.text();
        console.log("Body:", body);
    } catch (err) {
        console.error("Fetch error:", err);
    }
}

testFetch();
