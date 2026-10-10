import { createServer } from "node:http";

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/ping") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "Healthy", mode: "standby" }));
    return;
  }
  response.writeHead(503, { "content-type": "application/json" });
  response.end(JSON.stringify({
    error: "AgentCore is retained for compatibility but is not part of the fast media and vision path."
  }));
});

server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
