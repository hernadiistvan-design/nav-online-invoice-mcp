import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SHEET_URL = process.env.SHEET_URL;
const HONAP = (process.env.HONAP || "").trim();
const DIRECTION = (process.env.DIRECTION || "INBOUND").trim().toUpperCase();

function getRange() {
  if (/^\d{4}-\d{2}$/.test(HONAP)) {
    const [y,m] = HONAP.split("-").map(Number);
    return {
      dateFrom: `${y}-${String(m).padStart(2,'0')}-01`,
      dateTo:   `${y}-${String(m).padStart(2,'0')}-${new Date(y,m,0).getDate()}`,
      label: HONAP
    };
  }
  const n = new Date();
  let y = n.getUTCFullYear(), m = n.getUTCMonth();
  if (m===0){m=12;y--;}
  return {
    dateFrom: `${y}-${String(m).padStart(2,'0')}-01`,
    dateTo:   `${y}-${String(m).padStart(2,'0')}-${new Date(y,m,0).getDate()}`,
    label: `${y}-${String(m).padStart(2,'0')}`
  };
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

async function postRow(row) {
  await fetch(SHEET_URL, {
    method:"POST",
    headers:{"Content-Type":"text/plain;charset=utf-8"},
    body:JSON.stringify(row)
  });
}

async function main() {
  if (!SHEET_URL) throw new Error("Hiányzik a SHEET_URL.");
  const { dateFrom, dateTo, label } = getRange();
  const irany = DIRECTION === "OUTBOUND" ? "kiállított" : "bejövő";
  console.log(`Lekérendő: ${label} (${dateFrom} … ${dateTo}) - ${irany}`);

  const transport = new StdioClientTransport({ command:"node", args:["dist/cli.js"], env:process.env });
  const client = new Client({ name:"nav-sync", version:"1.0.0" }, { capabilities:{} });
  await client.connect(transport);

  const tools = await client.listTools();
  const digestTool = tools.tools.find(t => /digest/i.test(t.name) && /invoice/i.test(t.name));
  console.log("Digest tool:", digestTool?.name);

  const invoices = [];
  let page = 1, totalPages = 1;
  do {
    const res = await client.callTool({
      name: digestTool.name,
      arguments: { invoiceDirection: DIRECTION, dateFrom, dateTo, page }
    });
    const data = parseRaw(res);
    const ap = data?.invoiceDigestResult?.availablePage
      ?? data?.result?.invoiceDigestResult?.availablePage ?? 1;
    totalPages = Math.min(Number(ap) || 1, 50);
    findInvoices(data?.invoiceDigestResult ?? data?.result?.invoiceDigestResult ?? data, invoices);
    page++;
  } while (page <= totalPages);

  console.log(`Összesen talált: ${invoices.length}`);

  // Kliens oldali dátumszűrés — csak a kért hónap számlái
  const filtered = invoices.filter(inv => {
    const d = inv.invoiceIssueDate || inv.issueDate || "";
    if (!d) return true;
    return d >= dateFrom && d <= dateTo;
  });
  console.log(`Dátumszűrés után: ${filtered.length}`);

  const pmMap = { CASH:"készpénz", TRANSFER:"átutalás", CARD:"kártya", VOUCHER:"egyéb", OTHER:"egyéb" };
  let sent = 0;

  for (const inv of filtered) {
    const net   = Number(inv.invoiceNetAmount   || inv.invoiceNetAmountHUF   || 0);
    const vat   = Number(inv.invoiceVatAmount   || inv.invoiceVatAmountHUF   || 0);
    const gross = Number(inv.invoiceGrossAmount || inv.invoiceGrossAmountHUF || 0);
    const osszeg = gross || (net + vat) || 0;

    await postRow({
      datum:        inv.invoiceIssueDate || inv.issueDate || "",
      elado:        DIRECTION === "OUTBOUND" ? (inv.customerName||"") : (inv.supplierName||""),
      sorszam:      inv.invoiceNumber || "",
      fizetesi_mod: pmMap[inv.paymentMethod] || "",
      osszeg,
      penznem:      inv.currency || inv.currencyCode || "HUF",
      vevo:         process.env.NAV_TAX_NUMBER || "",
      fajl:         `NAV ${irany} ${label}`,
    });
    sent++;
    await new Promise(r=>setTimeout(r,100));
  }

  console.log(`Beküldve: ${sent} sor.`);
  await client.close();
}
main().catch(err => { console.error("HIBA:", err); process.exit(1); });
