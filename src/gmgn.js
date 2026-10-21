import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getJson } from "./h2.js";
import { request } from "./http.js";

const PERIODS = ["1m", "5m", "1h", "6h", "24h"];
const APP_VER = "20260424-12795-39b9a56";

function normalizeRank(payload) {
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rank)) return data.rank;
  if (Array.isArray(payload?.rank)) return payload.rank;
  return [];
}

function buildQuery(obj) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    if (Array.isArray(v)) for (const item of v) qs.append(k, String(item));
    else qs.set(k, String(v));
  }
  return qs.toString();
}

/** Stable per-install device identity, persisted so the fingerprint does not churn. */
function loadDevice(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (j.device_id && j.fp_did) return j;
  } catch {
    /* generate below */
  }
  const j = {
    device_id: crypto.randomUUID(),
    fp_did: crypto.randomBytes(16).toString("hex"),
    created: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
  return j;
}

function tzInfo(tz) {
  const now = new Date();
  const name = tz || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let offset = -now.getTimezoneOffset() * 60;
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: name, timeZoneName: "shortOffset" })
      .formatToParts(now)
      .find((p) => p.type === "timeZoneName");
    const m = part?.value?.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (m) offset = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 3600 + Number(m[3] || 0) * 60);
  } catch {
    /* keep local offset */
  }
  return { name, offset };
}

/**
 * Public web endpoint used by gmgn.ai/trend — no API key.
 * Needs HTTP/2 + Chrome TLS fingerprint (h2.js); plain HTTP/1.1 gets a Cloudflare 403.
 */
export class GmgnPublic {
  constructor({
    base = "https://gmgn.ai",
    deviceFile = "./data/device.json",
    cookie = null,
    lang = "id",
    timezone = null,
    timeout = 25000,
    pathStyle = "api", // "api" -> /api/v1/rank/...  |  "defi" -> /defi/quotation/v1/rank/...
    sendDeviceParams = true,
  } = {}) {
    this.base = base.replace(/\/$/, "");
    this.cookie = cookie;
    this.lang = lang;
    this.tz = tzInfo(timezone);
    this.timeout = timeout;
    this.device = loadDevice(deviceFile);
    this.clientId = `gmgn_web_${APP_VER}`;
    this.pathStyle = pathStyle;
    this.sendDeviceParams = sendDeviceParams;
  }

  #pathFor(chain, interval, qs) {
    const prefix = this.pathStyle === "defi" ? "/defi/quotation/v1/rank" : "/api/v1/rank";
    return `${prefix}/${chain}/swaps/${interval}?${qs}`;
  }

  async rank({
    chain = "sol",
    interval = "1m",
    orderby = "volume",
    direction = "desc",
    limit = 100,
    filters = ["renounced", "frozen"],
    minGasFee = 3,
  } = {}) {
    if (!PERIODS.includes(interval)) throw new Error(`interval must be one of ${PERIODS.join(", ")}`);

    const qs = buildQuery({
      ...(this.sendDeviceParams
        ? {
            device_id: this.device.device_id,
            fp_did: this.device.fp_did,
            client_id: this.clientId,
            from_app: "gmgn",
            app_ver: APP_VER,
            tz_name: this.tz.name,
            tz_offset: this.tz.offset,
            app_lang: this.lang,
            os: "web",
            worker: 0,
          }
        : {}),
      orderby,
      direction,
      limit,
      "filters[]": filters,
      min_gas_fee: minGasFee,
    });

    const res = await getJson(this.base, this.#pathFor(chain, interval, qs), {
      cookie: this.cookie,
      timeout: this.timeout,
    });

    if (res.status !== 200) {
      const err = new Error(`HTTP ${res.status} from rank endpoint — ${res.text.slice(0, 90).replace(/\s+/g, " ")}`);
      err.status = res.status;
      throw err;
    }
    let json;
    try {
      json = JSON.parse(res.text);
    } catch {
      const err = new Error("rank endpoint returned non-JSON");
      err.status = res.status;
      throw err;
    }
    if (json.code !== undefined && json.code !== 0) {
      const err = new Error(`gmgn code=${json.code} ${json.reason || ""} ${json.message || ""}`.trim());
      err.body = json;
      throw err;
    }
    return normalizeRank(json);
  }
}

/**
 * Official OpenAPI. Headers: X-APIKEY. Query: timestamp (unix seconds, +/-5s) + client_id (uuid).
 * Host: https://openapi.gmgn.ai
 */
export class GmgnOpenApi {
  constructor({ apiKey, clientId = null, base = "https://openapi.gmgn.ai", timeout = 20000 } = {}) {
    if (!apiKey) throw new Error("apiKey required");
    this.apiKey = apiKey;
    this.clientId = clientId;
    this.base = base.replace(/\/$/, "");
    this.timeout = timeout;
  }

  async #get(pathname, query = {}) {
    const q = {
      ...query,
      timestamp: Math.floor(Date.now() / 1000),
      client_id: this.clientId || crypto.randomUUID(),
    };
    const url = `${this.base}${pathname}?${buildQuery(q)}`;
    const res = await request(url, {
      headers: {
        "x-apikey": this.apiKey,
        "content-type": "application/json",
        "user-agent": "gmgn-volume-monitor/1.0",
      },
      timeout: this.timeout,
    });
    let json = null;
    try {
      json = JSON.parse(res.text);
    } catch {
      /* non-json */
    }
    if (res.status !== 200) {
      const err = new Error(`HTTP ${res.status} ${json?.error || ""} ${json?.message || ""}`.trim());
      err.status = res.status;
      err.body = json ?? res.text.slice(0, 300);
      throw err;
    }
    return json;
  }

  async rank({ chain = "sol", interval = "1h", orderby = "volume", direction = "desc", limit = 100, filters = ["not_honeypot"] } = {}) {
    const json = await this.#get("/v1/market/rank", {
      chain,
      interval,
      orderby,
      direction,
      limit,
      filters,
    });
    if (json?.code !== undefined && json.code !== 0 && json.code !== "0") {
      const err = new Error(`gmgn code=${json.code} ${json.error || ""} ${json.message || ""}`.trim());
      err.body = json;
      throw err;
    }
    return normalizeRank(json);
  }

  async tokenInfo(chain, address) {
    return this.#get("/v1/token/info", { chain, address });
  }

  async kline({ chain = "sol", address, resolution = "1m", from, to }) {
    return this.#get("/v1/market/token_kline", { chain, address, resolution, from, to });
  }
}

export { PERIODS, APP_VER };
