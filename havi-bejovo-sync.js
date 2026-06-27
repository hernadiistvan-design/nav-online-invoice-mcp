import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SHEET_URL = process.env.SHEET_URL;
const HONAP = (process.env.HONAP || "").trim();

function getRange() {
  if (/^\d{4}-\d{2}$/.test(HONAP)) {
    const [y,m] = HONAP.split("-").map(Number);
    return { dateFrom:`${y}-${String(m).padStart(2,'0')}-01`, dateTo:`${y}-${String(m).padStart(2,'0')}-${new Date(y,m,0).getDate()}`, label:HONAP };
  }
  const n = new Date();
  let y = n.getUTCFullYear(), m = n.getUTCMonth();
  if(m===0){m=12;y--;}
  return { dateFrom:`${y}-${String(m).padStart(2,'0')}-01`, dateTo:`${y}-${String(m).padStart(2,'0')}-${new Date(y,m,0).getDate()}`, label:`${y}-${String(m).padStart(2,'0')}` };
}

function parseRaw(res) {
  const txt = (res?.content||[]).filter(c=>c.type==="text").map(c=>c.text).join("\n").trim();
  // JSON blokk kinyerése a markdown szövegből
  const jsonMatch = txt.match(/```json\n([\s\S]*?)\n```/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1]); } catch(e) {}
  }
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
  await fetch(SHEET_URL, { method:"POST", headers:{"Content-Type":"text/plain;charset=utf-8"}, body:JSON.stringify(row) });
}

async function main() {
  if (!SHEET_URL) throw new Error("Hiányzik a SHEET_URL.");
  const { dateFrom, dateTo, label } = getRange();
  console.log(`Lekérendő: ${label} (${dateFrom} … ${dateTo})`);

  const transport = new StdioClientTransport({ command:"node", args:["dist/cli.js"], env:process.env });
  const client = new Client({ name:"nav-sync", version:"1.0.0" }, { capabilities:{} });
  await client.connect(transport);

  const tools = await client.listTools();
  const digestTool = tools.tools.find(t => /digest/i.test(t.name) && /invoice/i.test(t.name));
  console.log("Digest tool:", digestTool.name);

  const invoices = [];
  let page = 1, totalPages = 1;
  do {
    const res = await client.callTool({
      name: digestTool.name,
      arguments: { invoiceDirection:"INBOUND", dateFrom, dateTo, page }
    });
    const data = parseRaw(res);
    console.log(`Oldal ${page} kulcsok:`, Object.keys(data).join(", "));
    
    // availablePage keresése
    const ap = data?.invoiceDigestResult?.availablePage ?? data?.availablePage ?? data?.result?.invoiceDigestResult?.availablePage ?? 1;
    totalPages = Number(ap) || 1;
    console.log(`Oldalak: ${totalPages}`);
    
    // Számlák keresése
    const digestResult = data?.invoiceDigestResult ?? data?.result?.invoiceDigestResult ?? data;
    console.log(`digestResult kulcsok:`, JSON.stringify(digestResult).slice(0, 300));
    findInvoices(digestResult, invoices);
    page++;
  } while (page <= totalPages);

  console.log(`Talált számla: ${invoices.length}`);
  if (invoices.length > 0) console.log("Első számla:", JSON.stringify(invoices[0]).slice(0, 200));

  const pmMap = { CASH:"készpénz", TRANSFER:"átutalás", CARD:"kártya", VOUCHER:"egyéb", OTHER:"egyéb" };
  let sent = 0;
  for (const inv of invoices) {
    await postRow({
      datum: inv.invoiceIssueDate || inv.issueDate || "",
      elado: inv.supplierName || "",
      sorszam: inv.invoiceNumber || "",
      fizetesi_mod: pmMap[inv.paymentMethod] || "",
      osszeg: Number(inv.invoiceGrossAmount) || 0,
      penznem: inv.currency || inv.currencyCode || "HUF",
      vevo: process.env.NAV_TAX_NUMBER || "",
      fajl: `NAV bejövő ${label}`,
    });
    sent++;
  }
  console.log(`Beküldve: ${sent} sor.`);
  await client.close();
}
main().catch(err => { console.error("HIBA:", err); process.exit(1); });
