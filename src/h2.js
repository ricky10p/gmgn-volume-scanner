import http2 from "node:http2";
import http from "node:http";
import zlib from "node:zlib";

const CHROME_CIPHERS = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

const TLS_OPTS = {
  ciphers: CHROME_CIPHERS,
  ecdhCurve: "X25519:P-256:P-384",
  minVersion: "TLSv1.2",
  maxVersion: "TLSv1.3",
};

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

function decode(buf, encoding) {
  const enc = String(encoding || "").toLowerCase();
  try {
    if (enc === "br") return zlib.brotliDecompressSync(buf);
    if (enc === "gzip") return zlib.gunzipSync(buf);
    if (enc === "deflate") return zlib.inflateSync(buf);
    if (enc === "zstd" && typeof zlib.zstdDecompressSync === "function") return zlib.zstdDecompressSync(buf);
  } catch {
    /* fall through with raw buffer */
  }
  return buf;
}

/**
 * HTTP/2 GET with a Chrome-shaped TLS ClientHello.
 * gmgn.ai's edge rejects HTTP/1.1 from non-browser clients (403 "Attention Required")
 * but accepts h2 + Chrome cipher order.
 */
export function getJson(origin, pathWithQuery, { cookie = null, timeout = 25000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const isPlain = url.protocol === "http:";

    if (isPlain) {
      // local test harness only — real gmgn endpoints are https/h2
      const req = http.request(
        { host: url.hostname, port: url.port || 80, path: pathWithQuery, method: "GET", headers },
        (res) => {
          let text = "";
          res.on("data", (d) => (text += d.toString()));
          res.on("end", () => resolve({ status: res.statusCode, text }));
        }
      );
      req.on("error", reject);
      req.end();
      return;
    }

    const client = http2.connect(url.origin, TLS_OPTS);
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error("http2 timeout"));
    }, timeout);

    client.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });

    const reqHeaders = {
      ":method": "GET",
      ":path": pathWithQuery,
      ":authority": url.host,
      ":scheme": "https",
      "user-agent": BROWSER_UA,
      accept: "application/json, text/plain, */*",
      "accept-language": "id-ID,id;q=0.9,en;q=0.8",
      "accept-encoding": "gzip, deflate, br",
      referer: `${url.origin}/trend?chain=sol`,
      origin: url.origin,
      "sec-ch-ua": '"Chromium";v="139", "Not=A?Brand";v="24", "Google Chrome";v="139"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      ...headers,
    };
    if (cookie) reqHeaders.cookie = cookie;

    const req = client.request(reqHeaders);
    let status = 0;
    let enc = "";
    const chunks = [];

    req.on("response", (h) => {
      status = h[":status"];
      enc = h["content-encoding"] || "";
    });
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      clearTimeout(timer);
      client.close();
      const text = decode(Buffer.concat(chunks), enc).toString("utf8");
      resolve({ status, text });
    });
    req.on("error", (e) => {
      clearTimeout(timer);
      client.destroy();
      reject(e);
    });
    req.end();
  });
}

export { BROWSER_UA, TLS_OPTS };
