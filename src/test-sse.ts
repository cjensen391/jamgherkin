import { EventSource } from "eventsource";
import dotenv from "dotenv";

dotenv.config();

const url = "https://mcp.jam.dev/mcp";
const token = process.env.JAM_TOKEN;

console.log("Using token starting with:", token?.substring(0, 10));

const es = new EventSource(url, {
    headers: {
        "Authorization": `Bearer ${token}`
    }
} as any);

es.onopen = () => {
    console.log("Connection opened successfully!");
    es.close();
    process.exit(0);
};

es.onerror = (err: any) => {
    console.error("Connection error details:");
    console.error("Status:", err.status);
    console.error("Message:", err.message);
    es.close();
    process.exit(1);
};
