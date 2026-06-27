// Havi bejövő (INBOUND) számla szinkron
// ------------------------------------
// A Szotasz/nav-online-invoice-mcp szervert hajtja meg (a hitelesítést az kezeli),
// lekéri az adott hónap NEKED kiállított (INBOUND) számláit, és soronként
// elküldi a Google Sheet webhookba (ugyanaz, amit a számlaolvasónál beállítottál).
//
// Indítás a workflow-ból: node scripts/havi-bejovo-sync.mjs
// Környezeti változók: NAV_* (a repo .env szerint), SHEET_URL, opcionálisan HONAP=YYYY-MM

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SHEET_URL = process.env.SHEET_URL;
const HONAP = (process.env.HONAP || "").trim(); // "YYYY-MM" vagy üres = előző hónap

// ---- hónap-tartomány kiszámítása ----
function range() {
  let y, m; // m: 1-12
  if (/^\d{4}-\d{2}$/.test(HONAP)) {
    [y, m] = HONAP.split("-").map(Number);
  } else {
    const n = new Date();
    y = n.getUTCFullYear();
    m = n.getUTCMonth(); // 0-11 → ez már az ELŐZŐ hónap 1-12-ben
    if (m === 0) { m = 12; y -= 1; }
  }
  const first = new Date(Date.UTC(y, m - 1, 1));
  const last = new Date(Date.UTC(y, m, 0));
  const f = d => d.toISOString().slice(0, 10);
  return { dateFrom: f(first), dateTo: f(last), label: `${y}-${String(m).padStart(2, "0")}` };
}

// ---- mélykeresés egy kulcsra (a NAV JSON struktúrája beágyazott lehet) ----
function pick(obj, names) {
  if (obj == null || typeof obj !== "object") return undefined;
  for (const k of Object.keys(obj)) {
    if (names.includes(k)) return obj[k];
  }
  for (const k of Object.keys(obj)) {
    const r = pick(obj[k], names);
    if (r !== undefined) return r;
  }
  return undefined;
}
function collectInvoices(node, out = []) {
  if (node == null || typeof node !== "object") return out;
  // egy számla-digest ismérve: van invoiceNumber-szerű mezője
  if (pick(node, ["invoiceNumber"]) !== undefined && !Array.isArray(node)) {
    if (node.invoiceNumber !== undefined) out.push(node);
  }
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach(it => collectInvoices(it, out));
    else if (typeof v === "object") collectInvoices(v, out);
  }
  return out;
}
function parseToolResult(res) {
  const txt = (res?.content || [])
    .filter(c => c.type === "text").map(c => c.text).join("\n").trim();
  if (!txt) return res?.structuredContent ?? {};
  try { return JSON.parse(txt); } catch { return { _raw: txt }; }
}

async function postRow(row) {
  await fetch(SHEET_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(row),
  });
}

async function main() {
  if (!SHEET_URL) throw new Error("Hiányzik a SHEET_URL.");
  const { dateFrom, dateTo, label } = range();
  console.log(`Lekérendő időszak (INBOUND): ${dateFrom} … ${dateTo} (${label})`);

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/cli.js"],
    env: process.env,
  });
  const client = new Client({ name: "havi-bejovo-sync", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  // Diagnosztika: az első futásnál ebből látszik a pontos paraméter-séma.
  const tools = await client.listTools();
  console.log("Elérhető tool-ok:", tools.tools.map(t => t.name).join(", "));
  const digestTool = tools.tools.find(t => /digest/i.test(t.name) && /invoice/i.test(t.name));
  const dataTool = tools.tools.find(t => /invoice_data|invoiceData/i.test(t.name));
  if (digestTool) console.log("digest inputSchema:", JSON.stringify(digestTool.inputSchema));

  // --- A keresési paraméterek. Ha az első futás logja más mezőneveket mutat,
  //     itt kell igazítani (egy helyen). ---
  const digestArgs = {
    invoiceDirection: "INBOUND",
    dateFrom,
    dateTo,
    page: 1,
  };

  const invoices = [];
  let page = 1, totalPages = 1;
  do {
    const res = await client.callTool({ name: digestTool.name, arguments: { ...digestArgs, page } });
    const data = parseToolResult(res);
    if (page === 1) console.log("digest válasz (minta):", JSON.stringify(data).slice(0, 600));
    const ap = pick(data, ["availablePage", "availablePages"]);
    totalPages = Number(ap) || 1;
    collectInvoices(data, invoices);
    page++;
  } while (page <= totalPages);

  console.log(`Talált bejövő számla: ${invoices.length}`);

  let sent = 0;
  for (const inv of invoices) {
    const invoiceNumber = pick(inv, ["invoiceNumber"]);
    const supplierName = pick(inv, ["supplierName"]) || "";
    const supplierTax  = pick(inv, ["supplierTaxNumber"]) || "";
    const issueDate    = pick(inv, ["invoiceIssueDate", "issueDate"]) || "";
    let net  = Number(pick(inv, ["invoiceNetAmount"])) || 0;
    let vat  = Number(pick(inv, ["invoiceVatAmount"])) || 0;
    let gross = Number(pick(inv, ["invoiceGrossAmount"]));
    if (!gross) gross = net + vat;
    let currency = pick(inv, ["currency", "currencyCode"]) || "HUF";
    let paymentMethod = pick(inv, ["paymentMethod"]) || "";

    // Részletes adat a fizetési módhoz (a digest gyakran nem tartalmazza).
    if (dataTool && invoiceNumber) {
      try {
        const dres = await client.callTool({
          name: dataTool.name,
          arguments: { invoiceNumber, invoiceDirection: "INBOUND", supplierTaxNumber: supplierTax },
        });
        const ddata = parseToolResult(dres);
        paymentMethod = pick(ddata, ["paymentMethod"]) || paymentMethod;
        const g = Number(pick(ddata, ["invoiceGrossAmount", "invoiceGrossAmountNormalized"]));
        if (g) gross = g;
        currency = pick(ddata, ["currencyCode", "currency"]) || currency;
      } catch (e) {
        console.log(`  (részletes adat kihagyva: ${invoiceNumber} – ${e.message})`);
      }
    }

    const pmMap = { CASH: "készpénz", TRANSFER: "átutalás", CARD: "kártya", VOUCHER: "egyéb", OTHER: "egyéb" };
    const row = {
      datum: issueDate,
      elado: supplierName,
      sorszam: invoiceNumber || "",
      fizetesi_mod: pmMap[paymentMethod] || paymentMethod || "",
      osszeg: gross,
      penznem: currency,
      vevo: process.env.NAV_TAX_NUMBER || "",
      fajl: `NAV bejövő ${label}`,
    };
    await postRow(row);
    sent++;
  }

  console.log(`Beküldve a Sheetbe: ${sent} sor.`);
  await client.close();
}

main().catch(err => { console.error("HIBA:", err); process.exit(1); });
