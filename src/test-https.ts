import https from "https";
import dotenv from "dotenv";

dotenv.config();

const url = new URL("https://mcp.jam.dev/mcp");
const token = process.env.JAM_TOKEN;

const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: 'GET',
    headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'text/event-stream'
    }
};

console.log("Request Headers:", JSON.stringify(options.headers, null, 2));

const req = https.request(options, (res) => {
    console.log('Status Code:', res.statusCode);
    console.log('Response Headers:', JSON.stringify(res.headers, null, 2));

    res.on('data', (d) => {
        process.stdout.write(d);
    });
});

req.on('error', (e) => {
    console.error(e);
});

req.end();

setTimeout(() => {
    console.log("\nTiming out after 5s...");
    process.exit(0);
}, 5000);
