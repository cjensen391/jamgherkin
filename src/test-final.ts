import { EventSource } from "eventsource";
import dotenv from "dotenv";

dotenv.config();

const url = "https://mcp.jam.dev/mcp";
const token = process.env.JAM_TOKEN;

async function run() {
    console.log("Final attempt with combined Accept headers...");
    const es = new EventSource(url, {
        headers: {
            "Authorization": `Bearer ${token}`,
            "Accept": "application/json, text/event-stream"
        }
    } as any);

    es.onopen = () => {
        console.log("Success! Connection opened.");
        es.close();
        process.exit(0);
    };

    es.onerror = (err: any) => {
        console.error("Error Status:", err.status);
        console.error("Error Message:", err.message);
        es.close();
        process.exit(1);
    };
}

run();
