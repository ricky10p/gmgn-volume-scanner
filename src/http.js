import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import zlib from "node:zlib";
import { URL } from "node:url";

const DECODERS = {
  gzip: zlib.gunzipSync,
  deflate: zlib.inflateSync,
  br: zlib.brotliDecompressSync,
  zstd: typeof zlib.zstdDecompressSync === "function" ? zlib.zstdDecompressSync : null,
};

function tunnel(proxyUrl, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const headers = { host: `${host}:${port}` };
    if (p.username) {
      const cred = `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`;
      headers["proxy-authorization"] = `Basic ${Buffer.from(cred).toString("base64")}`;
    }
    const req = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers,
      timeout,
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.on("timeout", () => req.destroy(new Error("proxy connect timeout")));
    req.on("error", reject);
    req.end();
  });
}

export async function request(url, opts = {}) {
  const { headers = {}, proxy = null, timeout = 20000, method = "GET", body = null } = opts;
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const port = u.port ? Number(u.port) : isHttps ? 443 : 80;

  const reqHeaders = { "accept-encoding": "gzip, deflate, br", ...headers };
  if (body != null) reqHeaders["content-length"] = Buffer.byteLength(body);

  let socket = null;
  if (proxy) socket = await tunnel(proxy, u.hostname, port, timeout);

  const reqOpts = {
    method,
    host: u.hostname,
    port,
    path: u.pathname + u.search,
    headers: reqHeaders,
    agent: false,
    timeout,
  };
  if (socket) reqOpts.createConnection = () => tls.connect({ socket, servername: u.hostname });

  const mod = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request(reqOpts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers["content-encoding"] || "").toLowerCase();
        const dec = DECODERS[enc];
        if (dec) {
          try {
            buf = dec(buf);
          } catch {
            /* keep raw on decode failure */
          }
        }
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString("utf8") });
      });
    });
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}
