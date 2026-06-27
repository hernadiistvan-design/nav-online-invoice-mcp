import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SHEET_URL = process.env.SHEET_URL;
const HONAP = (process.env.HONAP || "").trim();
const DIRECTION = (process.env.DIRECTION || "INBOUND").trim().toUpperCase();

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
  const jsonMatch = txt.match(/```json\n([\s\S]*?)\n```/);
  if (jsonMatch) { try { return JSON.parse(jsonMatch[1]); } catch(e) {} }
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

function findAllNumbers(obj, prefix="", results={}) {
  if (!obj || typeof obj !== "object") return results;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "number" && v > 0) results[path] = v;
    else if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v) && Number(v) > 0) results[path] = Number(v);
    else if (typeof v === "object") findAllNumbers(v, path, results);
  }
  return results;
}

async function postRow(row) {
  await fetch(SHEET_URL, { method:"POST", headers:{"Content-Type":"text/plain;charset=utf-8"}, body:JSON.stringify(row) });
}

async function main() {
  if (!SHEET_URL) throw new Error("Hiányzik a SHEET_URL.");
  const { dateFrom, dateTo, label } = getRange();
  const irany = DIRECTION === "OUTBOUND" ? "kiállított" : "bejövő";
  console.log(`Lekérendő: ${label} - ${irany}`);

  const transport = new StdioClientTransport({ command:"node", args:["dist/cli.js"], env:process.env });
  const client = new Client({ name:"nav-sync", version:"1.0.0" }, { capabilities:{} });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("Összes tool:", tools.tools.map(t=>t.name).join(", "));
  const digestTool = tools.tools.find(t => /digest/i.test(t.name) && /invoice/i.test(t.name));
  const dataTool = tools.tools.find(t => /data/i.test(t.name) && /invoice/i.test(t.name) && !/digest/i.test(t.name));
  console.log("Digest:", digestTool?.name, "| Data:", dataTool?.name);

  const invoices = [];
  let page = 1, totalPages = 1;
  do {
    const res = await client.callTool({ name: digestTool.name, arguments: { invoiceDirection: DIRECTION, dateFrom, dateTo, page } });
    const data = parseRaw(res);
    const ap = data?.invoiceDigestResult?.availablePage ?? data?.result?.invoiceDigestResult?.availablePage ?? 1;
    totalPages = Number(ap) || 1;
    findInvoices(data?.invoiceDigestResult ?? data?.result?.invoiceDigestResult ?? data, invoices);
    page++;
  } while (page <= totalPages);

  console.log(`Talált: ${invoices.length}`);
  const pmMap = { CASH:"készpénz", TRANSFER:"átutalás", CARD:"kártya", VOUCHER:"egyéb", OTHER:"egyéb" };
  let sent = 0;
  let firstDataLogged = false;

  for (const inv of invoices) {
    const invoiceNumber = inv.invoiceNumber || "";
    let osszeg = 0;
    let fizetesiMod = pmMap[inv.paymentMethod] || "";
    let penznem = inv.currency || inv.currencyCode || "HUF";

    if (dataTool && invoiceNumber) {
      try {
        const dres = await client.callTool({ name: dataTool.name, arguments: { invoiceNumber, invoiceDirection: DIRECTION } });
        const ddata = parseRaw(dres);
        if (!firstDataLogged) {
          firstDataLogged = true;
          console.log("ÖSSZEG MEZŐK:", JSON.stringify(findAllNumbers(ddata)).slice(0, 500));
          console.log("TELJES VÁLASZ:", JSON.stringify(ddata).slice(0, 800));
        }
        const nums = findAllNumbers(ddata);
        const values = Object.entries(nums);
        if (values.length > 0) {
          const grossEntry = values.find(([k]) => /gross|brutto|vegosszeg|total/i.test(k));
          if (grossEntry) osszeg = grossEntry[1];
          else osszeg = Math.max(...values.map(([,v]) => v));
        }
        const pm = ddata?.paymentMethod || ddata?.invoiceData?.invoiceMain?.invoice?.paymentMethod;
        if (pm) fizetesiMod = pmMap[pm] || pm;
      } catch(e) {
        console.log(`  Hiba (${invoiceNumber}): ${e.message}`);
      }
      await new Promise(r=>setTimeout(r,200));
    }

    await postRow({ datum: inv.invoiceIssueDate || inv.issueDate || "", elado: DIRECTION === "OUTBOUND" ? (inv.customerName || "") : (inv.supplierName || ""), sorszam: invoiceNumber, fizetesi_mod: fizetesiMod, osszeg, penznem, vevo: process.env.NAV_TAX_NUMBER || "", fajl: `NAV ${irany} ${label}` });
    sent++;
  }
  console.log(`Beküldve: ${sent} sor.`);
  await client.close();
}
main().catch(err => { console.error("HIBA:", err); process.exit(1); });
