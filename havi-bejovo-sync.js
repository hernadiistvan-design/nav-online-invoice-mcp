import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const SHEET_URL = process.env.SHEET_URL;

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

async function getMeglevoSorszamok() {
 try {
   const url = SHEET_URL + '?action=getSorszamok&tab=NAV+bej%C3%B6v%C5%91';
   const resp = await fetch(url);
   if (resp.ok) {
     const data = await resp.json();
     console.log(`Már meglévő számlák: ${data.length}`);
     return new Set(data);
   }
 } catch(e) {
   console.log('Meglévő számlák lekérése sikertelen:', e.message);
 }
 return new Set();
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
   method: "POST",
   headers: { "Content-Type": "text/plain;charset=utf-8" },
   body: JSON.stringify(row)
 });
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

 const meglevo = await getMeglevoSorszamok();

 const transport = new StdioClientTransport({ command:"node", args:["dist/cli.js"], env:process.env });
 const client = new Client({ name:"nav-sync", version:"1.0.0" }, { capabilities:{} });
 await client.connect(transport);

 const tools = await client.listTools();
 const digestTool = tools.tools.find(t => /digest/i.test(t.name) && /invoice/i.test(t.name));
 console.log("Digest tool:", digestTool?.name);

 const pmMap = { CASH:"készpénz", TRANSFER:"átutalás", CARD:"kártya", VOUCHER:"egyéb", OTHER:"egyéb" };
 let osszesUj = 0;

 for (const { dateFrom, dateTo, label } of months) {
   const invoices = await fetchMonth(client, digestTool, dateFrom, dateTo);
   const ujak = invoices.filter(inv => {
     const sz = String(inv.invoiceNumber || "").trim();
     return sz && !meglevo.has(sz);
   });
   console.log(`${label}: ${invoices.length} talált, ${ujak.length} új`);

   for (const inv of ujak) {
     const net   = Number(inv.invoiceNetAmount   || inv.invoiceNetAmountHUF   || 0);
     const vat   = Number(inv.invoiceVatAmount   || inv.invoiceVatAmountHUF   || 0);
     const gross = Number(inv.invoiceGrossAmount || inv.invoiceGrossAmountHUF || 0);
     const osszeg = gross || (net + vat) || 0;
     await postRow({
       datum:        inv.invoiceIssueDate || inv.issueDate || "",
       elado:        inv.supplierName || "",
       sorszam:      String(inv.invoiceNumber || ""),
       fizetesi_mod: pmMap[inv.paymentMethod] || "",
       osszeg,
       penznem:      inv.currency || inv.currencyCode || "HUF",
       vevo:         process.env.NAV_TAX_NUMBER || "",
       fajl:         `NAV bejövő ${label}`,
     });
     meglevo.add(String(inv.invoiceNumber || "").trim());
     osszesUj++;
     await new Promise(r => setTimeout(r, 150));
   }
   await new Promise(r => setTimeout(r, 300));
 }

 console.log(`Kész. Összesen beküldve: ${osszesUj} új sor.`);
 await client.close();
}
main().catch(err => { console.error("HIBA:", err); process.exit(1); });
