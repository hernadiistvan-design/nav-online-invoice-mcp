import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SHEET_URL = process.env.SHEET_URL;
// Webhook védelmi kulcs — a Sheet (Apps Script) csak ezzel válaszol. GitHub Secret: SHEET_TOKEN
const SHEET_TOKEN = process.env.SHEET_TOKEN || "";

function getMonths() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth() + 1;
  const months = [];
  for (let m = 1; m <= currentMonth; m++) {
    const mm = String(m).padStart(2, '0');
    const lastDay = new Date(y, m, 0).getDate();
    const dateTo = m === currentMonth ? now.toISOString().slice(0, 10) : `${y}-${mm}-${lastDay}`;
    months.push({ dateFrom: `${y}-${mm}-01`, dateTo, label: `${y}-${mm}` });
  }
  return months;
}

// Sorszám-normalizálás — UGYANAZ a szabály, mint az Apps Script normSorsz()-ában
// (kisbetű, minden szóköz nélkül), hogy a két oldal biztosan ugyanúgy hasonlítson.
function norm(s) {
  return String(s ?? "").toLowerCase().replace(/\s+/g, "").trim();
}

// Lekéri a már meglévő számlasorszámokat a Sheetből.
// FONTOS: ha a lekérés elbukik, NEM megyünk tovább üres listával (az az egész év
// újraküldését = tömeges duplikációt okozná), hanem hibával leállunk.
// Egyetlen kivétel: ALLOW_EMPTY_SHEET=1 env (tudatos első futás, üres fülre).
async function getMeglevoSorszamok() {
  const url = SHEET_URL + '?action=getSorszamok&tab=NAV+bej%C3%B6v%C5%91&token=' + encodeURIComponent(SHEET_TOKEN);
  let data;
  try {
    const resp = await fetch(url, { redirect: "follow" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const text = await resp.text();
    try { data = JSON.parse(text); }
    catch { throw new Error("A válasz nem JSON (bejelentkező oldal / rossz URL?): " + text.slice(0, 120)); }
    if (data && data.error === "unauthorized") throw new Error("A Sheet elutasította (unauthorized) — hiányzik vagy rossz a SHEET_TOKEN secret.");
    if (!Array.isArray(data)) throw new Error("A válasz nem tömb: " + JSON.stringify(data).slice(0, 120));
  } catch (e) {
    if (process.env.ALLOW_EMPTY_SHEET === "1") {
      console.warn("FIGYELEM: a meglévő sorszámok lekérése sikertelen, de ALLOW_EMPTY_SHEET=1 → üres listával folytatom:", e.message);
      return new Set();
    }
    throw new Error("A meglévő sorszámok lekérése sikertelen — leállok, hogy ne duplikáljak. Ok: " + e.message);
  }
  const set = new Set(data.map(norm).filter(Boolean));
  console.log(`Már meglévő számlák: ${set.size}`);
  return set;
}

function parseRaw(res) {
  const txt = (res?.content||[]).filter(c=>c.type==="text").map(c=>c.text).join("\n").trim();
  const jm = txt.match(/```json\n([\s\S]*?)\n```/);
  if (jm) { try { return JSON.parse(jm[1]); } catch(e) {} }
  try { return JSON.parse(txt); } catch(e) {}
  return { _raw: txt };
}

function findInvoices(obj, out=[]) {
  if (!obj || typeof obj !== "object") return out;
  if (Array.isArray(obj)) { obj.forEach(i => findInvoices(i, out)); return out; }
  if (obj.invoiceNumber !== undefined) { out.push(obj); return out; }
  for (const v of Object.values(obj)) findInvoices(v, out);
  return out;
}

// Visszaad: "ok" | "dup" (a szerver duplikátumként kihagyta, V25+) | "err"
async function postRow(row) {
  const resp = await fetch(SHEET_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ ...row, token: SHEET_TOKEN })
  });
  let j = null;
  try { j = await resp.json(); } catch {}
  // Rossz/hiányzó token → azonnal leállunk (nem csendben "ok"-ozunk tovább)
  if (j && j.error === "unauthorized") throw new Error("A Sheet elutasította (unauthorized) — hiányzik vagy rossz a SHEET_TOKEN secret.");
  if (j && j.duplikalt) return "dup";
  if (j && j.ok === false) { console.warn("Szerver hiba:", j.error); return "err"; }
  return "ok";
}

async function fetchMonth(client, digestTool, dateFrom, dateTo) {
  const invoices = [];
  let page = 1, totalPages = 1;
  do {
    const res = await client.callTool({
      name: digestTool.name,
      arguments: { invoiceDirection: "INBOUND", dateFrom, dateTo, page }
    });
    const data = parseRaw(res);
    const ap = data?.invoiceDigestResult?.availablePage
      ?? data?.result?.invoiceDigestResult?.availablePage ?? 1;
    totalPages = Math.min(Number(ap) || 1, 50);
    findInvoices(data?.invoiceDigestResult ?? data?.result?.invoiceDigestResult ?? data, invoices);
    page++;
  } while (page <= totalPages);
  return invoices;
}

async function main() {
  if (!SHEET_URL) throw new Error("Hiányzik a SHEET_URL.");
  const months = getMonths();
  console.log(`Lekérendő hónapok: ${months.map(m => m.label).join(', ')}`);

  // Meglévő számlák — hiba esetén leáll (lásd getMeglevoSorszamok)
  const meglevo = await getMeglevoSorszamok();

  const transport = new StdioClientTransport({ command:"node", args:["dist/cli.js"], env:process.env });
  const client = new Client({ name:"nav-sync", version:"1.1.0" }, { capabilities:{} });
  await client.connect(transport);

  const tools = await client.listTools();
  const digestTool = tools.tools.find(t => /digest/i.test(t.name) && /invoice/i.test(t.name));
  console.log("Digest tool:", digestTool?.name);

  const pmMap = { CASH:"készpénz", TRANSFER:"átutalás", CARD:"kártya", VOUCHER:"egyéb", OTHER:"egyéb" };
  let osszesUj = 0, osszesDup = 0, osszesHiba = 0;

  for (const { dateFrom, dateTo, label } of months) {
    const invoices = await fetchMonth(client, digestTool, dateFrom, dateTo);
    const ujak = invoices.filter(inv => {
      const k = norm(inv.invoiceNumber);
      return k && !meglevo.has(k);
    });
    console.log(`${label}: ${invoices.length} talált, ${ujak.length} új`);

    for (const inv of ujak) {
      const k = norm(inv.invoiceNumber);
      if (meglevo.has(k)) continue; // ugyanabban a hónapban kétszer szereplő sorszám
      const net = Number(inv.invoiceNetAmount || inv.invoiceNetAmountHUF || 0);
      const vat = Number(inv.invoiceVatAmount || inv.invoiceVatAmountHUF || 0);
      const gross = Number(inv.invoiceGrossAmount || inv.invoiceGrossAmountHUF || 0);
      const osszeg = gross || (net + vat) || 0;
      const r = await postRow({
        datum: inv.invoiceIssueDate || inv.issueDate || "",
        elado: inv.supplierName || "",
        sorszam: String(inv.invoiceNumber || ""),
        fizetesi_mod: pmMap[inv.paymentMethod] || "",
        osszeg,
        penznem: inv.currency || inv.currencyCode || "HUF",
        vevo: process.env.NAV_TAX_NUMBER || "",
        fajl: `NAV bejövő ${label}`,
      });
      meglevo.add(k);
      if (r === "dup") osszesDup++; else if (r === "err") osszesHiba++; else osszesUj++;
      await new Promise(r => setTimeout(r, 150));
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`Kész. Beküldve: ${osszesUj} új sor. Szerver által duplikátumként kihagyva: ${osszesDup}. Hiba: ${osszesHiba}.`);
  await client.close();
}
main().catch(err => { console.error("HIBA:", err); process.exit(1); });
éüéééééüéééáá
